import type { JobDefinition } from '../../../../daemon-runtime/jobs.js';
import * as log from '../../../../util/log.js';
import type { Signaller } from '../agent-ci-control.js';
import { emitTaskEvent } from '../events.js';
import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent, listTasks, tryLoadTask } from '../fs-store.js';
import { EventKind } from '../schemas.js';
import { getTaskHierarchy } from './aggregate.js';
import type { FeatureLifecycleContext } from './feature-lifecycle.js';
import { markFeatureBlocked, markFeaturePassed } from './feature-lifecycle.js';
import { BudgetExhaustedError, createGeneratedFixFeature } from './fix-feature.js';
import type { Assertion, Feature, ValidatorRun } from './schemas.js';
import { FeatureLoopState, ValidatorRunStatus } from './schemas.js';
import type { ValidatorContext } from './validator.js';
import { listValidatorRuns, recordValidatorRun, updateValidatorRun } from './validator.js';

//#region Constants

const VALIDATOR_TICK_INTERVAL_MS = 30_000;

//#endregion

//#region Types

/**
 * Outcome reported back by an external validator runner. Mirrors the legacy
 * `ValidatorRunResult` minus the runId (caller already knows it).
 */
export interface ValidatorRunOutcome {
  readonly status: 'pass' | 'fail' | 'blocked' | 'error';
  readonly summary: string;
  readonly blockedReason?: string;
  readonly result?: Record<string, unknown>;
}

/**
 * Inputs handed to the injectable validator runner. The caller wires this
 * up to the actual subprocess / harness; this module orchestrates the
 * surrounding lifecycle (record → run → dispatch).
 */
export interface RunValidatorArgs {
  readonly ctx: ValidatorContext;
  readonly feature: Feature;
  readonly assertions: ReadonlyArray<Assertion>;
  readonly run: ValidatorRun;
}

export type RunValidatorFn = (args: RunValidatorArgs) => Promise<ValidatorRunOutcome>;

/** Long-lived dependencies passed to the validator daemon job. */
export interface ValidatorJobDeps {
  readonly ctx: TaskStoreContext;
  readonly signaller: Signaller;
  readonly runValidator: RunValidatorFn;
}

//#endregion

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface StructuredTask {
  readonly taskId: string;
  readonly features: ReadonlyArray<Feature>;
  readonly assertionsByMilestone: ReadonlyMap<string, ReadonlyArray<Assertion>>;
  /** featureId → milestoneId resolution for assertion lookups. */
  readonly featureMilestone: ReadonlyMap<string, string>;
}

async function gatherStructuredTasks(ctx: TaskStoreContext): Promise<StructuredTask[]> {
  const out: StructuredTask[] = [];
  const tasks = await listTasks(ctx);
  for (const task of tasks) {
    const hierarchy = await getTaskHierarchy(ctx, task.id);
    if (hierarchy === null) {
      continue;
    }
    const features: Feature[] = [];
    const assertionsByMilestone = new Map<string, Assertion[]>();
    const featureMilestone = new Map<string, string>();
    for (const milestone of hierarchy.milestones) {
      assertionsByMilestone.set(milestone.id, milestone.assertions.slice());
      for (const slice of milestone.slices) {
        for (const feature of slice.features) {
          features.push(feature);
          featureMilestone.set(feature.id, milestone.id);
        }
      }
    }
    out.push({
      taskId: task.id,
      features,
      assertionsByMilestone,
      featureMilestone,
    });
  }
  return out;
}

function assertionAppliesToFeature(assertion: Assertion, featureId: string): boolean {
  if (assertion.featureIds.length === 0) {
    return true;
  }
  return assertion.featureIds.includes(featureId);
}

function selectAssertionsForFeature(structured: StructuredTask, feature: Feature): Assertion[] {
  const milestoneId = structured.featureMilestone.get(feature.id);
  if (milestoneId === undefined) {
    return [];
  }
  const candidates = structured.assertionsByMilestone.get(milestoneId) ?? [];
  return candidates.filter((assertion) => assertionAppliesToFeature(assertion, feature.id));
}

async function emitValidatorRunRecorded(
  ctx: TaskStoreContext,
  taskId: string,
  run: ValidatorRun,
): Promise<void> {
  const event = await appendEvent(ctx, {
    kind: EventKind.ValidatorRunRecorded,
    taskId,
    payload: {
      runId: run.id,
      featureId: run.featureId,
      status: run.status,
    },
    ts: nowIso(),
  });
  emitTaskEvent(event);
}

async function emitFeatureLoopStateChanged(
  ctx: TaskStoreContext,
  taskId: string,
  payload: {
    readonly featureId: string;
    readonly previousLoopState: FeatureLoopState;
    readonly loopState: FeatureLoopState;
  },
): Promise<void> {
  const event = await appendEvent(ctx, {
    kind: EventKind.FeatureLoopStateChanged,
    taskId,
    payload,
    ts: nowIso(),
  });
  emitTaskEvent(event);
}

async function emitFeatureFixGenerated(
  ctx: TaskStoreContext,
  taskId: string,
  payload: {
    readonly sourceFeatureId: string;
    readonly fixFeatureId: string;
    readonly validatorRunId: string;
  },
): Promise<void> {
  const event = await appendEvent(ctx, {
    kind: EventKind.FeatureFixGenerated,
    taskId,
    payload,
    ts: nowIso(),
  });
  emitTaskEvent(event);
}

async function emitFeatureBudgetExhausted(
  ctx: TaskStoreContext,
  taskId: string,
  payload: {
    readonly featureId: string;
    readonly attemptCount: number;
    readonly budget: number;
  },
): Promise<void> {
  const event = await appendEvent(ctx, {
    kind: EventKind.FeatureBudgetExhausted,
    taskId,
    payload,
    ts: nowIso(),
  });
  emitTaskEvent(event);
}

//#endregion

//#region Result handlers

interface HandleResultArgs {
  readonly deps: ValidatorJobDeps;
  readonly taskId: string;
  readonly feature: Feature;
  readonly run: ValidatorRun;
  readonly outcome: ValidatorRunOutcome;
}

async function handlePassResult(args: HandleResultArgs): Promise<void> {
  const lifecycleCtx: FeatureLifecycleContext = {
    ...args.deps.ctx,
    taskId: args.taskId,
  };
  const change = await markFeaturePassed(lifecycleCtx, args.feature.id);
  if (change === null) {
    return;
  }
  await emitFeatureLoopStateChanged(args.deps.ctx, args.taskId, change);
}

async function handleFailResult(args: HandleResultArgs): Promise<void> {
  const lifecycleCtx: FeatureLifecycleContext = {
    ...args.deps.ctx,
    taskId: args.taskId,
  };
  try {
    const fix = await createGeneratedFixFeature(
      {
        ...args.deps.ctx,
        taskId: args.taskId,
      },
      {
        sourceFeatureId: args.feature.id,
        validatorRunId: args.run.id,
      },
    );
    await emitFeatureFixGenerated(args.deps.ctx, args.taskId, {
      sourceFeatureId: args.feature.id,
      fixFeatureId: fix.fixFeature.id,
      validatorRunId: args.run.id,
    });
    if (fix.budgetRemaining === 0) {
      await emitFeatureBudgetExhausted(args.deps.ctx, args.taskId, {
        featureId: args.feature.id,
        attemptCount: fix.sourceUpdated.implementationAttemptCount,
        budget: fix.sourceUpdated.implementationAttemptCount,
      });
    }
  } catch (err) {
    if (!(err instanceof BudgetExhaustedError)) {
      throw err;
    }
    const change = await markFeatureBlocked(
      lifecycleCtx,
      args.feature.id,
      `Implementation retry budget exhausted (${err.attemptCount}/${err.budget}).`,
    );
    if (change !== null) {
      await emitFeatureLoopStateChanged(args.deps.ctx, args.taskId, change);
    }
    await emitFeatureBudgetExhausted(args.deps.ctx, args.taskId, {
      featureId: args.feature.id,
      attemptCount: err.attemptCount,
      budget: err.budget,
    });
  }
}

async function handleBlockedResult(args: HandleResultArgs): Promise<void> {
  const lifecycleCtx: FeatureLifecycleContext = {
    ...args.deps.ctx,
    taskId: args.taskId,
  };
  const reason = args.outcome.blockedReason ?? args.outcome.summary;
  const change = await markFeatureBlocked(lifecycleCtx, args.feature.id, reason);
  if (change === null) {
    return;
  }
  await emitFeatureLoopStateChanged(args.deps.ctx, args.taskId, change);
}

function handleErrorResult(args: HandleResultArgs): void {
  log.warn(
    `[tasks.validator] feature ${args.feature.id} validator errored: ${args.outcome.summary}`,
  );
}

const resultHandlers: Record<
  ValidatorRunOutcome['status'],
  (args: HandleResultArgs) => Promise<void> | void
> = {
  pass: handlePassResult,
  fail: handleFailResult,
  blocked: handleBlockedResult,
  error: handleErrorResult,
};

//#endregion

//#region Tick

async function findInflightRun(
  ctx: ValidatorContext,
  featureId: string,
): Promise<ValidatorRun | null> {
  const runs = await listValidatorRuns(ctx, featureId);
  for (const run of runs) {
    if (run.status === ValidatorRunStatus.Running && run.completedAt === null) {
      return run;
    }
  }
  return null;
}

async function reapStaleRunForFeature(
  deps: ValidatorJobDeps,
  taskId: string,
  featureId: string,
): Promise<void> {
  const ctx: ValidatorContext = {
    ...deps.ctx,
    taskId,
  };
  const runs = await listValidatorRuns(ctx, featureId);
  for (const run of runs) {
    if (run.status !== ValidatorRunStatus.Running || run.pid === null) {
      continue;
    }
    if (deps.signaller.isAlive(run.pid)) {
      continue;
    }
    await updateValidatorRun(ctx, {
      featureId,
      runId: run.id,
      patch: {
        status: ValidatorRunStatus.Error,
        completedAt: nowIso(),
        result: {
          error: `pid ${run.pid} no longer alive (reaped by validator job)`,
        },
      },
    });
  }
}

interface RunFeatureValidationArgs {
  readonly deps: ValidatorJobDeps;
  readonly structured: StructuredTask;
  readonly feature: Feature;
}

async function runFeatureValidation(args: RunFeatureValidationArgs): Promise<void> {
  const { deps, structured, feature } = args;
  if (feature.taskId === null) {
    log.warn(
      `[tasks.validator] feature ${feature.id} is validating but has no linked task; skipping`,
    );
    return;
  }
  await reapStaleRunForFeature(deps, structured.taskId, feature.id);
  const validatorCtx: ValidatorContext = {
    ...deps.ctx,
    taskId: structured.taskId,
  };
  const inflight = await findInflightRun(validatorCtx, feature.id);
  if (inflight !== null) {
    return;
  }
  const linkedTask = await tryLoadTask(deps.ctx, feature.taskId);
  if (linkedTask === null) {
    log.warn(`[tasks.validator] feature ${feature.id} references missing task ${feature.taskId}`);
    return;
  }
  const assertions = selectAssertionsForFeature(structured, feature);
  // Open the run row in 'running' so the worker can mutate it atomically.
  const run = await recordValidatorRun(validatorCtx, {
    featureId: feature.id,
    status: ValidatorRunStatus.Running,
    startedAt: nowIso(),
  });
  await emitValidatorRunRecorded(deps.ctx, structured.taskId, run);

  let outcome: ValidatorRunOutcome;
  try {
    outcome = await deps.runValidator({
      ctx: validatorCtx,
      feature,
      assertions,
      run,
    });
  } catch (err) {
    const message = errorMessage(err);
    await updateValidatorRun(validatorCtx, {
      featureId: feature.id,
      runId: run.id,
      patch: {
        status: ValidatorRunStatus.Error,
        completedAt: nowIso(),
        result: {
          error: message,
        },
      },
    });
    log.warn(`[tasks.validator] feature ${feature.id} validator threw: ${message}`);
    return;
  }

  const terminal: ValidatorRunStatus =
    outcome.status === 'pass'
      ? ValidatorRunStatus.Pass
      : outcome.status === 'fail'
        ? ValidatorRunStatus.Fail
        : outcome.status === 'blocked'
          ? ValidatorRunStatus.Blocked
          : ValidatorRunStatus.Error;
  const finalRun = await updateValidatorRun(validatorCtx, {
    featureId: feature.id,
    runId: run.id,
    patch: {
      status: terminal,
      completedAt: nowIso(),
      result: outcome.result ?? {
        summary: outcome.summary,
        blockedReason: outcome.blockedReason ?? null,
      },
    },
  });

  const handler = resultHandlers[outcome.status];
  await handler({
    deps,
    taskId: structured.taskId,
    feature,
    run: finalRun,
    outcome,
  });
}

async function reapAllStaleRunningRuns(deps: ValidatorJobDeps): Promise<void> {
  const tasks = await listTasks(deps.ctx);
  for (const task of tasks) {
    const hierarchy = await getTaskHierarchy(deps.ctx, task.id);
    if (hierarchy === null) {
      continue;
    }
    for (const milestone of hierarchy.milestones) {
      for (const slice of milestone.slices) {
        for (const feature of slice.features) {
          await reapStaleRunForFeature(deps, task.id, feature.id);
        }
      }
    }
  }
}

async function runValidatorTick(deps: ValidatorJobDeps): Promise<void> {
  await reapAllStaleRunningRuns(deps);
  const structuredTasks = await gatherStructuredTasks(deps.ctx);
  for (const structured of structuredTasks) {
    const validating = structured.features.filter(
      (feature) => feature.loopState === FeatureLoopState.Validating,
    );
    for (const feature of validating) {
      try {
        await runFeatureValidation({
          deps,
          structured,
          feature,
        });
      } catch (err) {
        log.warn(`[tasks.validator] feature ${feature.id} validation failed: ${errorMessage(err)}`);
      }
    }
  }
}

//#endregion

//#region Public API

/** Daemon job: scan validating features, run the validator, dispatch on result. */
export function tasksValidatorPollJob(deps: ValidatorJobDeps): JobDefinition {
  return {
    id: 'tasks.validator.poll',
    intervalMs: VALIDATOR_TICK_INTERVAL_MS,
    runOnStart: true,
    run: async () => {
      await runValidatorTick(deps);
    },
  };
}

/** Test seam: drive a single validator-job tick deterministically. */
export async function _testRunValidatorTick(deps: ValidatorJobDeps): Promise<void> {
  await runValidatorTick(deps);
}

//#endregion
