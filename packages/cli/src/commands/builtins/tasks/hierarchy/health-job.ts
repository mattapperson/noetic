import type { Feature, ValidatorRun } from '@noetic/code-agent/tasks/schema';
import { FeatureLoopState, ValidatorRunStatus } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { listTasks, tryLoadTask } from '@noetic/code-agent/tasks/store/fs-node';
import * as log from '../../../../util/log.js';
import type { Signaller } from '../agent-ci-control.js';
import { getTaskHierarchy } from './aggregate.js';
import type { FeatureLifecycleContext } from './feature-lifecycle.js';
import { markFeatureBlocked } from './feature-lifecycle.js';
import type { ValidatorContext } from './validator.js';
import { listValidatorRuns, updateValidatorRun } from './validator.js';

//#region Types

/** Long-lived dependencies passed to the health daemon job. */
export interface HealthJobDeps {
  readonly ctx: TaskStoreContext;
  readonly signaller: Signaller;
}

//#endregion

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

interface RunIdentityArgs {
  readonly signaller: Signaller;
  readonly run: ValidatorRun;
}

function isRunIdentityValid(args: RunIdentityArgs): boolean {
  if (args.run.pid === null) {
    return true;
  }
  if (!args.signaller.isAlive(args.run.pid)) {
    return false;
  }
  if (args.run.pidStarttime === null) {
    return true;
  }
  const current = args.signaller.startTime(args.run.pid);
  if (current === null) {
    return false;
  }
  return current === args.run.pidStarttime;
}

interface StructuredEntry {
  readonly taskId: string;
  readonly features: ReadonlyArray<Feature>;
}

async function collectStructuredEntries(ctx: TaskStoreContext): Promise<StructuredEntry[]> {
  const out: StructuredEntry[] = [];
  for (const task of await listTasks(ctx)) {
    const hierarchy = await getTaskHierarchy(ctx, task.id);
    if (hierarchy === null) {
      continue;
    }
    const features: Feature[] = [];
    for (const milestone of hierarchy.milestones) {
      for (const slice of milestone.slices) {
        for (const feature of slice.features) {
          features.push(feature);
        }
      }
    }
    out.push({
      taskId: task.id,
      features,
    });
  }
  return out;
}

//#endregion

//#region Tick steps

async function reapStaleValidatorRuns(deps: HealthJobDeps): Promise<number> {
  const entries = await collectStructuredEntries(deps.ctx);
  let reaped = 0;
  for (const entry of entries) {
    const validatorCtx: ValidatorContext = {
      ...deps.ctx,
      taskId: entry.taskId,
    };
    for (const feature of entry.features) {
      const runs = await listValidatorRuns(validatorCtx, feature.id);
      for (const run of runs) {
        if (run.status !== ValidatorRunStatus.Running) {
          continue;
        }
        if (
          isRunIdentityValid({
            signaller: deps.signaller,
            run,
          })
        ) {
          continue;
        }
        await updateValidatorRun(validatorCtx, {
          featureId: feature.id,
          runId: run.id,
          patch: {
            status: ValidatorRunStatus.Error,
            completedAt: nowIso(),
            result: {
              error: `pid ${run.pid ?? '<none>'} no longer alive (reaped by health job)`,
            },
          },
        });
        reaped += 1;
      }
    }
  }
  return reaped;
}

async function reconcileFeatureLinkageDrift(deps: HealthJobDeps): Promise<number> {
  const entries = await collectStructuredEntries(deps.ctx);
  const inflight: ReadonlyArray<FeatureLoopState> = [
    FeatureLoopState.Implementing,
    FeatureLoopState.Validating,
  ];
  let reconciled = 0;
  for (const entry of entries) {
    const lifecycleCtx: FeatureLifecycleContext = {
      ...deps.ctx,
      taskId: entry.taskId,
    };
    for (const feature of entry.features) {
      if (feature.taskId === null) {
        continue;
      }
      if (!inflight.includes(feature.loopState)) {
        continue;
      }
      const linked = await tryLoadTask(deps.ctx, feature.taskId);
      if (linked !== null) {
        continue;
      }
      await markFeatureBlocked(
        lifecycleCtx,
        feature.id,
        `Linked task ${feature.taskId} was deleted while feature was ${feature.loopState}.`,
      );
      reconciled += 1;
    }
  }
  return reconciled;
}

/**
 * Drive a single health tick: reap stale validator runs whose pids are no
 * longer alive (or whose start-time changed indicating pid recycling) and
 * mark in-flight features whose linked leaf task was deleted as blocked.
 *
 * Exported so the daemon's health flow (`health-flow.ts`) can drive a single
 * pass through `harness.run(healthTickStep, ...)` while preserving the
 * `_testRunHealthTick` surface used by existing tests.
 */
export async function runHealthTick(deps: HealthJobDeps): Promise<void> {
  const reapedRuns = await reapStaleValidatorRuns(deps);
  const reconciledFeatures = await reconcileFeatureLinkageDrift(deps);
  if (reapedRuns > 0 || reconciledFeatures > 0) {
    log.warn(
      `[tasks.health] reaped ${reapedRuns} stale validator run(s); reconciled ${reconciledFeatures} feature(s) with deleted tasks`,
    );
  }
}

//#endregion

//#region Public API

/** Test seam: drive a single health-job tick deterministically. */
export async function _testRunHealthTick(deps: HealthJobDeps): Promise<void> {
  await runHealthTick(deps);
}

//#endregion
