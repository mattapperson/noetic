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

import type {
  FeatureLoopStateChangedMessage,
  ValidatorRequest,
} from '@noetic/code-agent/tasks/ipc-node';
import { featureLoopStateChan, validatorRequestChan } from '@noetic/code-agent/tasks/ipc-node';
import type { Feature } from '@noetic/code-agent/tasks/schema';
import { FeatureLoopState } from '@noetic/code-agent/tasks/schema';
import { tryLoadTask } from '@noetic/code-agent/tasks/store/fs-node';
import type { ContextMemory, Step } from '@noetic/core';
import { every, step } from '@noetic/core';
import * as log from '../../../../util/log.js';
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

async function processOneRequest(
  deps: ValidatorFlowDeps,
  request: ValidatorRequest,
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
 * channel and runs each feature validation. The deps bundle is augmented
 * with a `publishLoopStateChange` binding that fires `featureLoopStateChan`
 * whenever a feature transitions, so the autopilot's `wakeOn` reacts to
 * validator outcomes without polling the JSONL tail.
 */
export function buildValidatorIterationStep(
  deps: ValidatorFlowDeps,
): Step<ContextMemory, void, void> {
  return step.run<ContextMemory, void, void>({
    id: 'validator.iteration',
    execute: async (_input, ctx): Promise<void> => {
      const enriched: ValidatorFlowDeps = {
        ...deps,
        publishLoopStateChange: (msg): void => {
          const message: FeatureLoopStateChangedMessage = {
            taskId: msg.taskId,
            featureId: msg.featureId,
            previousLoopState: msg.previousLoopState,
            loopState: msg.loopState,
          };
          ctx.send(featureLoopStateChan, message);
        },
      };
      const requests = await drainValidatorRequests(() => ctx.tryRecv(validatorRequestChan));
      for (const request of requests) {
        await processOneRequest(enriched, request);
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
