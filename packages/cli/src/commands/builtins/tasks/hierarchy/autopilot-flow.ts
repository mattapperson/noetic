/**
 * Autopilot flow — the strategic-task state machine reified as a noetic
 * Step composition.
 *
 * Each tick scans every autopilot-enabled task, classifies the active slice,
 * and routes through a `branch` to one of: handle-all-passed, handle-blocked,
 * handle-empty, or pass-through (in-progress). Pure FS state mutations live
 * in the imperative {@link runAutopilotTick} body, which the flow's
 * `step.run` body re-uses verbatim so the existing tests stay green.
 *
 * After the scan, every feature currently in `Validating` is announced on
 * `validatorRequestChan` and `featureLoopStateChan` so the validator flow
 * (which `wakeOn`s `validatorRequestChan`) tick immediately rather than
 * waiting for its 30s safety interval.
 *
 * Composed as `every({ step: autopilotTickStep, ms: 60_000, wakeOn: featureLoopStateChan })`
 * so it also wakes early on any feature loop-state transition.
 */

import type { ContextMemory, Step, StepBranch } from '@noetic/core';
import { branch, every, step } from '@noetic/core';

import type { FeatureLoopStateChangedMessage, ValidatorRequest } from '../channels.js';
import { featureLoopStateChan, validatorRequestChan } from '../channels.js';
import type { TaskStoreContext } from '../fs-store.js';
import { listTasks } from '../fs-store.js';
import { HierarchyStatus } from '../schemas.js';
import { getTaskHierarchy } from './aggregate.js';
import type {
  AutopilotDeps,
  AutopilotTickReport,
  FeatureGroups,
  SliceCompletionDecision,
} from './autopilot.js';
import {
  classifySliceCompletion,
  groupFeaturesByLoopState,
  runAutopilotTick,
} from './autopilot.js';
import type { Feature, MilestoneWithChildren, SliceWithFeatures } from './schemas.js';
import { FeatureLoopState, SliceStatus } from './schemas.js';

//#region Constants

const AUTOPILOT_TICK_INTERVAL_MS = 60_000;

//#endregion

//#region Types

/** Long-lived dependencies passed to the autopilot flow. */
export type AutopilotFlowDeps = AutopilotDeps;

/**
 * Inputs passed to `tickOneTaskStep`: the task id under inspection and the
 * shared deps reference. The step loads the hierarchy from disk so writes
 * by the autopilot scan body are observable.
 */
export interface TickOneTaskInput {
  readonly deps: AutopilotDeps;
  readonly taskId: string;
}

/** Output of `tickOneTaskStep`: enough context for `sliceDecisionBranch`. */
export interface TickOneTaskOutput {
  readonly deps: AutopilotDeps;
  readonly taskId: string;
  readonly decision: SliceCompletionDecision;
  readonly activeSlice: SliceWithFeatures | null;
  readonly milestone: MilestoneWithChildren | null;
  readonly groups: FeatureGroups | null;
}

//#endregion

//#region Composable steps (public — preserved for future direct composition)

/**
 * Per-task classifier: reload the hierarchy, find the active slice, classify
 * it. Pure read-only — no FS mutations. Pairs with {@link sliceDecisionBranch}
 * to drive the per-task state transitions.
 */
export const tickOneTaskStep: Step<ContextMemory, TickOneTaskInput, TickOneTaskOutput> = step.run<
  ContextMemory,
  TickOneTaskInput,
  TickOneTaskOutput
>({
  id: 'autopilot.tick-one-task',
  execute: async (input): Promise<TickOneTaskOutput> => {
    const hierarchy = await getTaskHierarchy(input.deps.ctx, input.taskId);
    if (hierarchy === null) {
      return {
        deps: input.deps,
        taskId: input.taskId,
        decision: {
          kind: 'empty',
        },
        activeSlice: null,
        milestone: null,
        groups: null,
      };
    }
    const active = findActiveSliceLookup(hierarchy.milestones);
    if (active === null) {
      return {
        deps: input.deps,
        taskId: input.taskId,
        decision: {
          kind: 'empty',
        },
        activeSlice: null,
        milestone: null,
        groups: null,
      };
    }
    const groups = groupFeaturesByLoopState(active.slice.features);
    const decision = classifySliceCompletion(groups);
    return {
      deps: input.deps,
      taskId: input.taskId,
      decision,
      activeSlice: active.slice,
      milestone: active.milestone,
      groups,
    };
  },
});

/**
 * No-op pass-through used by `sliceDecisionBranch` for the `in_progress`
 * decision (autopilot keeps watching but takes no action this tick).
 */
const handleInProgressStep: Step<ContextMemory, TickOneTaskOutput, TickOneTaskOutput> = step.run<
  ContextMemory,
  TickOneTaskOutput,
  TickOneTaskOutput
>({
  id: 'autopilot.handle-in-progress',
  execute: async (input): Promise<TickOneTaskOutput> => input,
});

/**
 * Terminal step for the `all_passed` decision. The actual slice/milestone
 * advancement runs in {@link runAutopilotTick}; this step exists so the
 * branch surface is symmetrical and so traces show one span per outcome.
 */
const handleAllPassedStep: Step<ContextMemory, TickOneTaskOutput, TickOneTaskOutput> = step.run<
  ContextMemory,
  TickOneTaskOutput,
  TickOneTaskOutput
>({
  id: 'autopilot.handle-all-passed',
  execute: async (input): Promise<TickOneTaskOutput> => input,
});

/** Terminal step for the `any_blocked` decision (taskBlocked counter bumped by the scan body). */
const handleBlockedStep: Step<ContextMemory, TickOneTaskOutput, TickOneTaskOutput> = step.run<
  ContextMemory,
  TickOneTaskOutput,
  TickOneTaskOutput
>({
  id: 'autopilot.handle-blocked',
  execute: async (input): Promise<TickOneTaskOutput> => input,
});

/** Terminal step for the `empty` decision (slice with zero features ⇒ treated as passed). */
const handleEmptyStep: Step<ContextMemory, TickOneTaskOutput, TickOneTaskOutput> = step.run<
  ContextMemory,
  TickOneTaskOutput,
  TickOneTaskOutput
>({
  id: 'autopilot.handle-empty',
  execute: async (input): Promise<TickOneTaskOutput> => input,
});

/**
 * Routes a `tickOneTaskStep` output to the matching terminal step based on
 * the slice classification. `in_progress` falls through `handleInProgressStep`
 * (returned via the registry below).
 */
export const sliceDecisionBranch: StepBranch<ContextMemory, TickOneTaskOutput, TickOneTaskOutput> =
  branch<ContextMemory, TickOneTaskOutput, TickOneTaskOutput>({
    id: 'autopilot.slice-decision',
    route: (input): Step<ContextMemory, TickOneTaskOutput, TickOneTaskOutput> | null => {
      const handler = sliceDecisionHandlers[input.decision.kind];
      return handler;
    },
  });

//#endregion

//#region Helper registry

const sliceDecisionHandlers: Record<
  SliceCompletionDecision['kind'],
  Step<ContextMemory, TickOneTaskOutput, TickOneTaskOutput>
> = {
  all_passed: handleAllPassedStep,
  any_blocked: handleBlockedStep,
  empty: handleEmptyStep,
  in_progress: handleInProgressStep,
};

interface SliceLookup {
  readonly milestone: MilestoneWithChildren;
  readonly slice: SliceWithFeatures;
}

function findActiveSliceLookup(
  milestones: ReadonlyArray<MilestoneWithChildren>,
): SliceLookup | null {
  for (const milestone of milestones) {
    for (const slice of milestone.slices) {
      if (slice.status === SliceStatus.Active) {
        return {
          milestone,
          slice,
        };
      }
    }
  }
  return null;
}

interface ValidatingFeature {
  readonly taskId: string;
  readonly feature: Feature;
}

async function gatherValidatingFeatures(
  ctx: TaskStoreContext,
): Promise<ReadonlyArray<ValidatingFeature>> {
  const out: ValidatingFeature[] = [];
  const tasks = await listTasks(ctx);
  for (const task of tasks) {
    if (
      task.hierarchyStatus !== HierarchyStatus.Active &&
      task.hierarchyStatus !== HierarchyStatus.Planning
    ) {
      continue;
    }
    const hierarchy = await getTaskHierarchy(ctx, task.id);
    if (hierarchy === null) {
      continue;
    }
    for (const milestone of hierarchy.milestones) {
      for (const slice of milestone.slices) {
        for (const feature of slice.features) {
          if (feature.loopState !== FeatureLoopState.Validating) {
            continue;
          }
          out.push({
            taskId: task.id,
            feature,
          });
        }
      }
    }
  }
  return out;
}

//#endregion

//#region Tick step

/**
 * Build the per-tick `step.run` that drives one full autopilot scan. The
 * body delegates to the imperative {@link runAutopilotTick} for the FS state
 * transitions, then announces every currently-validating feature on the
 * inter-step channels so the validator flow wakes immediately.
 */
export function buildAutopilotTickStep(
  deps: AutopilotFlowDeps,
): Step<ContextMemory, void, AutopilotTickReport> {
  return step.run<ContextMemory, void, AutopilotTickReport>({
    id: 'autopilot.scan-and-tick',
    execute: async (_input, ctx): Promise<AutopilotTickReport> => {
      const report = await runAutopilotTick(deps);
      const validating = await gatherValidatingFeatures(deps.ctx);
      for (const entry of validating) {
        const request: ValidatorRequest = {
          taskId: entry.taskId,
          featureId: entry.feature.id,
        };
        ctx.send(validatorRequestChan, request);
        const message: FeatureLoopStateChangedMessage = {
          taskId: entry.taskId,
          featureId: entry.feature.id,
          previousLoopState: entry.feature.loopState,
          loopState: entry.feature.loopState,
        };
        ctx.send(featureLoopStateChan, message);
      }
      return report;
    },
  });
}

//#endregion

//#region Public API

/**
 * Build the autopilot `every` for the daemon flow. Period is `60_000` ms
 * with `wakeOn: featureLoopStateChan` so the autopilot ticks immediately on
 * any loop-state transition. `onError: 'continue'` keeps the daemon up.
 *
 * The tick step's `AutopilotTickReport` payload is dropped at this layer
 * via a thin `step.run` adapter so the result composes cleanly into a
 * `fork({ mode: 'all' })` whose paths must be uniformly typed `Step<void, void>`.
 */
export function buildAutopilotEvery(
  deps: AutopilotFlowDeps,
): ReturnType<typeof every<ContextMemory, void, void>> {
  const tickWithReport = buildAutopilotTickStep(deps);
  const tickVoid = step.run<ContextMemory, void, void>({
    id: 'autopilot.scan-and-tick.void',
    execute: async (_input, ctx): Promise<void> => {
      await ctx.harness.run(tickWithReport, undefined, ctx);
    },
  });
  return every<ContextMemory, void, void>({
    id: 'autopilot.every',
    step: tickVoid,
    ms: AUTOPILOT_TICK_INTERVAL_MS,
    wakeOn: featureLoopStateChan,
    onError: 'continue',
  });
}

//#endregion
