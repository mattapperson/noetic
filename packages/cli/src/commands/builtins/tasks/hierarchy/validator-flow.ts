/**
 * Validator flow — drains `validatorRequestChan`, evaluates each requested
 * feature, persists the run row, and dispatches on the outcome (pass / fail
 * → fix / blocked / error). Each iteration is a `step.run` whose body
 * delegates to the imperative `runFeatureValidation` (which owns the FS
 * writes, lifecycle transitions, fix-feature dispatch, and budget-exhausted
 * fallback).
 *
 * Composed as `every({ step: validatorIterationStep, ms: 30_000, wakeOn: validatorRequestChan })`
 * so a request wakes the iteration immediately; the 30s safety interval
 * catches missed wakeups.
 *
 * The `_testRunValidatorTick` surface in `validator-job.ts` is preserved so
 * the existing pass/fail/blocked/budget-exhausted/throws tests stay green;
 * the new flow tests drive an iteration through `harness.run(validatorIterationStep, ...)`.
 */

import type { ContextMemory, Step } from '@noetic/core';
import { every, step } from '@noetic/core';
import * as log from '../../../../util/log.js';
import type { ValidatorRequest } from '../channels.js';
import { ValidatorOutcomeStatus, validatorOutcomeChan, validatorRequestChan } from '../channels.js';
import { tryLoadTask } from '../fs-store.js';
import type { Feature } from './schemas.js';
import { FeatureLoopState, ValidatorRunStatus } from './schemas.js';
import type { ValidatorContext } from './validator.js';
import { listValidatorRuns } from './validator.js';
import type { StructuredTask, ValidatorJobDeps } from './validator-job.js';
import { gatherStructuredTasks, runFeatureValidation } from './validator-job.js';

//#region Constants

const VALIDATOR_TICK_INTERVAL_MS = 30_000;

//#endregion

//#region Types

/** Long-lived dependencies passed to the validator flow. */
export type ValidatorFlowDeps = ValidatorJobDeps;

//#endregion

//#region Helpers

function findFeatureInStructured(structured: StructuredTask, featureId: string): Feature | null {
  for (const feature of structured.features) {
    if (feature.id === featureId) {
      return feature;
    }
  }
  return null;
}

async function findStructuredForRequest(
  deps: ValidatorFlowDeps,
  request: ValidatorRequest,
): Promise<{
  structured: StructuredTask;
  feature: Feature;
} | null> {
  const tasks = await gatherStructuredTasks(deps.ctx);
  for (const structured of tasks) {
    if (structured.taskId !== request.taskId) {
      continue;
    }
    const feature = findFeatureInStructured(structured, request.featureId);
    if (feature === null) {
      log.warn(
        `[tasks.validator-flow] request for unknown feature ${request.featureId} in task ${request.taskId}`,
      );
      return null;
    }
    return {
      structured,
      feature,
    };
  }
  log.warn(`[tasks.validator-flow] request for unknown task ${request.taskId}`);
  return null;
}

function mapValidatorRunStatusToOutcomeStatus(
  status: ValidatorRunStatus,
): (typeof ValidatorOutcomeStatus)[keyof typeof ValidatorOutcomeStatus] | null {
  if (status === ValidatorRunStatus.Pass) {
    return ValidatorOutcomeStatus.Pass;
  }
  if (status === ValidatorRunStatus.Fail) {
    return ValidatorOutcomeStatus.Fail;
  }
  if (status === ValidatorRunStatus.Blocked) {
    return ValidatorOutcomeStatus.Blocked;
  }
  return null;
}

async function publishLatestOutcome(
  ctx: ValidatorContext,
  request: ValidatorRequest,
  send: (value: {
    taskId: string;
    featureId: string;
    runId: string;
    status: (typeof ValidatorOutcomeStatus)[keyof typeof ValidatorOutcomeStatus];
    result: Record<string, unknown> | null;
  }) => void,
): Promise<void> {
  const runs = await listValidatorRuns(ctx, request.featureId);
  if (runs.length === 0) {
    return;
  }
  const latest = runs[runs.length - 1];
  if (latest === undefined) {
    return;
  }
  const outcomeStatus = mapValidatorRunStatusToOutcomeStatus(latest.status);
  if (outcomeStatus === null) {
    return;
  }
  send({
    taskId: request.taskId,
    featureId: request.featureId,
    runId: latest.id,
    status: outcomeStatus,
    result: latest.result,
  });
}

async function processOneRequest(
  deps: ValidatorFlowDeps,
  request: ValidatorRequest,
  emitOutcome: (value: {
    taskId: string;
    featureId: string;
    runId: string;
    status: (typeof ValidatorOutcomeStatus)[keyof typeof ValidatorOutcomeStatus];
    result: Record<string, unknown> | null;
  }) => void,
): Promise<void> {
  const found = await findStructuredForRequest(deps, request);
  if (found === null) {
    return;
  }
  const { structured, feature } = found;
  if (feature.loopState !== FeatureLoopState.Validating) {
    log.warn(
      `[tasks.validator-flow] feature ${feature.id} not in validating state (${feature.loopState}); skipping`,
    );
    return;
  }
  if (feature.taskId !== null) {
    const linked = await tryLoadTask(deps.ctx, feature.taskId);
    if (linked === null) {
      log.warn(
        `[tasks.validator-flow] feature ${feature.id} references missing task ${feature.taskId}`,
      );
      return;
    }
  }
  await runFeatureValidation({
    deps,
    structured,
    feature,
  });
  await publishLatestOutcome(
    {
      ...deps.ctx,
      taskId: structured.taskId,
    },
    request,
    emitOutcome,
  );
}

async function drainValidatorRequests(
  tryRecv: () => ValidatorRequest | null,
): Promise<ReadonlyArray<ValidatorRequest>> {
  const out: ValidatorRequest[] = [];
  while (true) {
    const next = tryRecv();
    if (next === null) {
      break;
    }
    out.push(next);
  }
  return out;
}

//#endregion

//#region Steps

/**
 * Build the per-iteration `step.run` that drains the validator-request
 * channel, runs each feature validation, and publishes the outcome.
 */
export function buildValidatorIterationStep(
  deps: ValidatorFlowDeps,
): Step<ContextMemory, void, void> {
  return step.run<ContextMemory, void, void>({
    id: 'validator.iteration',
    execute: async (_input, ctx): Promise<void> => {
      const requests = await drainValidatorRequests(() => ctx.tryRecv(validatorRequestChan));
      for (const request of requests) {
        await processOneRequest(deps, request, (value) => ctx.send(validatorOutcomeChan, value));
      }
    },
  });
}

//#endregion

//#region Public API

/**
 * Build the validator `every` for the daemon flow. Period is `30_000` ms
 * with `wakeOn: validatorRequestChan` so the iteration runs immediately on
 * any request. `onError: 'continue'` keeps the daemon up across transient
 * subprocess / FS failures.
 */
export function buildValidatorEvery(
  deps: ValidatorFlowDeps,
): ReturnType<typeof every<ContextMemory, void, void>> {
  return every<ContextMemory, void, void>({
    id: 'validator.every',
    step: buildValidatorIterationStep(deps),
    ms: VALIDATOR_TICK_INTERVAL_MS,
    wakeOn: validatorRequestChan,
    onError: 'continue',
  });
}

//#endregion
