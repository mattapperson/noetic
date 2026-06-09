import type {
  Feature,
  Milestone,
  MilestoneWithChildren,
  Slice,
  SliceWithFeatures,
  Task,
} from '@noetic-tools/code-agent/tasks/schema';
import {
  AutopilotState,
  EventKind,
  FeatureLoopState,
  HierarchyStatus,
  MilestoneStatus,
  SliceStatus,
  TaskLifecycleStatus,
  TaskReviewStatus,
} from '@noetic-tools/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic-tools/code-agent/tasks/store/fs-node';
import {
  appendEvent,
  hasHierarchy,
  listTasks,
  saveTask,
  tryLoadTask,
} from '@noetic-tools/code-agent/tasks/store/fs-node';
import type { SubprocessAdapter } from '@noetic-tools/core';
import * as log from '../../../util/log.js';
import type { Signaller } from '../agent-ci-control.js';
import type {
  StartImplementerRunArgs,
  StartImplementerRunResult,
} from '../implementer-launcher.js';
import {
  MAX_PLANNER_ATTEMPTS,
  readPlannerAttemptsFromDisk,
} from '../memory/planner-attempt-layer.js';
import type { StartPlannerRunArgs, StartPlannerRunResult } from '../planner-launcher.js';
import { activateSlice } from './activation.js';
import { getTaskHierarchy } from './aggregate.js';
import { saveMilestone, saveSlice } from './store.js';

//#region Types

/**
 * Launchers the autopilot may invoke when the plan-pass / implement-pass
 * find an eligible task or feature. Both default to no-ops in tests so
 * the existing tick logic can run without spawning real subprocesses.
 */
export type StartPlannerRunFn = (args: StartPlannerRunArgs) => Promise<StartPlannerRunResult>;
export type StartImplementerRunFn = (
  args: StartImplementerRunArgs,
) => Promise<StartImplementerRunResult>;

/** Long-lived dependencies shared by the autopilot/validator/health daemons. */
export interface AutopilotDeps {
  readonly ctx: TaskStoreContext;
  readonly signaller: Signaller;
  /**
   * Shared subprocess adapter — launchers query its handle manifest to
   * detect in-flight runners and spawn new ones via it.
   */
  readonly subprocess: SubprocessAdapter;
  /** Test seam — invoked once per eligible task in the plan-pass. */
  readonly startPlannerRun?: StartPlannerRunFn;
  /** Test seam — invoked once per eligible feature in the implement-pass. */
  readonly startImplementerRun?: StartImplementerRunFn;
}

/** Aggregate counts produced by a single autopilot tick. */
export interface AutopilotTickReport {
  tasksScanned: number;
  slicesActivated: number;
  featuresTriaged: number;
  validatingTransitions: number;
  slicesCompleted: number;
  tasksCompleted: number;
  tasksBlocked: number;
  plannersStarted: number;
  implementersStarted: number;
}

interface FeatureGroups {
  idle: Feature[];
  implementing: Feature[];
  validating: Feature[];
  passed: Feature[];
  needsFix: Feature[];
  blocked: Feature[];
}

interface TaskTickContext {
  readonly task: Task;
  readonly milestones: ReadonlyArray<MilestoneWithChildren>;
  readonly report: AutopilotTickReport;
}

interface SliceContext {
  readonly task: Task;
  readonly milestone: MilestoneWithChildren;
  readonly slice: SliceWithFeatures;
  readonly report: AutopilotTickReport;
}

//#endregion

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

function emptyReport(): AutopilotTickReport {
  return {
    tasksScanned: 0,
    slicesActivated: 0,
    featuresTriaged: 0,
    validatingTransitions: 0,
    slicesCompleted: 0,
    tasksCompleted: 0,
    tasksBlocked: 0,
    plannersStarted: 0,
    implementersStarted: 0,
  };
}

/**
 * Branch name for an implementer-spawned worktree. Deterministic by
 * leaf task id so re-spawns reuse the same worktree, and safe per
 * `worktree-provision.ts#isSafeBranchName` (alphanumerics + slash + dash).
 */
function deriveBranchForLeaf(leafTaskId: string): string {
  return `noetic/${leafTaskId}`;
}

interface RunPlanPassArgs {
  readonly deps: AutopilotDeps;
  readonly tasks: ReadonlyArray<Task>;
  readonly report: AutopilotTickReport;
}

/**
 * Spawn the planner subprocess for every autopilot-enabled manual task
 * that hasn't yet been planned. The launcher itself is responsible for
 * the live-sidecar guard (it throws `PlannerSpawnError` on collision);
 * we swallow that error here so a single in-flight planner doesn't
 * break the rest of the tick.
 */
async function runPlanPass(args: RunPlanPassArgs): Promise<void> {
  const startPlannerRun = args.deps.startPlannerRun;
  if (startPlannerRun === undefined) {
    return;
  }
  // Load the per-task planner attempt counts once at the start of the
  // pass — they're written by the planner subprocess via its memory
  // layer, and we read them here to gate spawning so the autopilot
  // doesn't re-fire planners that have already exhausted their budget.
  const attempts = await readPlannerAttemptsFromDisk({
    fs: args.deps.ctx.fs,
    projectRoot: args.deps.ctx.projectRoot,
  });
  for (const task of args.tasks) {
    if (!task.autopilotEnabled) {
      continue;
    }
    // Disk-level hierarchy presence is authoritative; `task.hierarchyStatus`
    // is null for manual hierarchies, so checking the field would burn a
    // planner spawn per tick on tasks built via `add-milestone`.
    if (await hasHierarchy(args.deps.ctx, task.id)) {
      continue;
    }
    if (task.reviewStatus !== TaskReviewStatus.NotStarted) {
      continue;
    }
    if (task.autopilotState === AutopilotState.Planning) {
      continue;
    }
    // Cap spawns per task: a permanently-failing planner would otherwise
    // burn LLM tokens every 60s. Counter persists via the layer-backed JSON.
    const taskAttempts = attempts[task.id] ?? 0;
    if (taskAttempts >= MAX_PLANNER_ATTEMPTS) {
      log.warn(
        `[tasks.autopilot] plan-pass: budget exhausted for ${task.id} (${taskAttempts}/${MAX_PLANNER_ATTEMPTS})`,
      );
      continue;
    }
    try {
      await startPlannerRun({
        ctx: args.deps.ctx,
        taskId: task.id,
        subprocess: args.deps.subprocess,
      });
      args.report.plannersStarted += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[tasks.autopilot] plan-pass failed for ${task.id}: ${message}`);
    }
  }
}

interface RunImplementPassArgs {
  readonly deps: AutopilotDeps;
  readonly tasks: ReadonlyArray<Task>;
  readonly report: AutopilotTickReport;
}

interface ImplementCandidate {
  readonly parentTaskId: string;
  readonly feature: Feature;
  /** Non-null narrow of `feature.taskId`, captured at yield time. */
  readonly leafTaskId: string;
}

/**
 * Walk one structured task's hierarchy and yield every feature in
 * `loopState === 'implementing'` whose linked leaf id is non-null.
 * Pulled into a generator so the outer pass body stays flat.
 */
function* eachImplementingFeature(
  parentTaskId: string,
  hierarchy: {
    milestones: ReadonlyArray<MilestoneWithChildren>;
  },
): Generator<ImplementCandidate> {
  for (const milestone of hierarchy.milestones) {
    for (const slice of milestone.slices) {
      for (const feature of slice.features) {
        if (feature.loopState !== FeatureLoopState.Implementing) {
          continue;
        }
        if (feature.taskId === null) {
          continue;
        }
        yield {
          parentTaskId,
          feature,
          leafTaskId: feature.taskId,
        };
      }
    }
  }
}

/**
 * Spawn the implementer subprocess for every triaged feature whose
 * linked leaf task hasn't been provisioned yet. Gathers candidates
 * across all structured tasks first, batch-loads their leaf records
 * in parallel, then dispatches the launcher serially (sequencing the
 * launcher calls keeps per-task event ordering deterministic and
 * avoids two concurrent launchers racing the same `_implementer.json`
 * sidecar). Launcher errors are logged and swallowed so one bad spawn
 * doesn't break the rest of the tick.
 */
async function runImplementPass(args: RunImplementPassArgs): Promise<void> {
  const startImplementerRun = args.deps.startImplementerRun;
  if (startImplementerRun === undefined) {
    return;
  }
  const candidates: ImplementCandidate[] = [];
  for (const task of args.tasks) {
    // Same disk-level check as plan-pass; the `task.hierarchyStatus`
    // field is unreliable for manual hierarchies.
    if (!(await hasHierarchy(args.deps.ctx, task.id))) {
      continue;
    }
    const hierarchy = await getTaskHierarchy(args.deps.ctx, task.id);
    if (hierarchy === null) {
      continue;
    }
    for (const candidate of eachImplementingFeature(task.id, hierarchy)) {
      candidates.push(candidate);
    }
  }
  if (candidates.length === 0) {
    return;
  }
  // Batch-load the leaf records in parallel — each is an independent
  // FS read with no shared state. The generator already filtered
  // null `feature.taskId`, so every candidate has a `leafTaskId`.
  const leaves = await Promise.all(candidates.map((c) => tryLoadTask(args.deps.ctx, c.leafTaskId)));
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const leaf = leaves[i];
    if (candidate === undefined || !leaf) {
      continue;
    }
    if (leaf.worktreePath !== null) {
      continue;
    }
    const branch = leaf.branch ?? deriveBranchForLeaf(leaf.id);
    try {
      await startImplementerRun({
        ctx: args.deps.ctx,
        taskId: leaf.id,
        parentTaskId: candidate.parentTaskId,
        featureId: candidate.feature.id,
        branch,
        subprocess: args.deps.subprocess,
      });
      args.report.implementersStarted += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        `[tasks.autopilot] implement-pass failed for feature ${candidate.feature.id} (leaf ${leaf.id}): ${message}`,
      );
    }
  }
}

export function groupFeaturesByLoopState(features: ReadonlyArray<Feature>): FeatureGroups {
  const groups: FeatureGroups = {
    idle: [],
    implementing: [],
    validating: [],
    passed: [],
    needsFix: [],
    blocked: [],
  };
  for (const feature of features) {
    appendByLoopState(groups, feature);
  }
  return groups;
}

function appendByLoopState(groups: FeatureGroups, feature: Feature): void {
  if (feature.loopState === FeatureLoopState.Idle) {
    groups.idle.push(feature);
    return;
  }
  if (feature.loopState === FeatureLoopState.Implementing) {
    groups.implementing.push(feature);
    return;
  }
  if (feature.loopState === FeatureLoopState.Validating) {
    groups.validating.push(feature);
    return;
  }
  if (feature.loopState === FeatureLoopState.Passed) {
    groups.passed.push(feature);
    return;
  }
  if (feature.loopState === FeatureLoopState.NeedsFix) {
    groups.needsFix.push(feature);
    return;
  }
  groups.blocked.push(feature);
}

async function patchTaskAutopilot(
  ctx: TaskStoreContext,
  task: Task,
  patch: {
    readonly autopilotState?: AutopilotState;
    readonly hierarchyStatus?: HierarchyStatus;
    readonly lifecycleStatus?: TaskLifecycleStatus;
  },
): Promise<Task> {
  const ts = nowIso();
  const next: Task = {
    ...task,
    autopilotState: patch.autopilotState ?? task.autopilotState,
    hierarchyStatus:
      patch.hierarchyStatus !== undefined ? patch.hierarchyStatus : task.hierarchyStatus,
    lifecycleStatus: patch.lifecycleStatus ?? task.lifecycleStatus,
    lastAutopilotActivityAt: ts,
    updatedAt: ts,
  };
  await saveTask(ctx, next);
  return next;
}

async function setTaskAutopilotState(
  ctx: TaskStoreContext,
  task: Task,
  next: AutopilotState,
): Promise<Task> {
  if (task.autopilotState === next) {
    return task;
  }
  return patchTaskAutopilot(ctx, task, {
    autopilotState: next,
  });
}

async function setTaskHierarchyStatus(
  ctx: TaskStoreContext,
  task: Task,
  next: HierarchyStatus,
): Promise<Task> {
  if (task.hierarchyStatus === next) {
    return task;
  }
  const updated = await patchTaskAutopilot(ctx, task, {
    hierarchyStatus: next,
  });
  await appendEvent(ctx, {
    kind: EventKind.HierarchyStatusChanged,
    taskId: task.id,
    payload: {
      hierarchyStatus: next,
    },
    ts: nowIso(),
  });
  return updated;
}

async function markSliceComplete(ctx: TaskStoreContext, task: Task, slice: Slice): Promise<void> {
  await saveSlice(ctx, task.id, {
    ...slice,
    status: SliceStatus.Complete,
    updatedAt: nowIso(),
  });
}

async function markMilestoneComplete(
  ctx: TaskStoreContext,
  task: Task,
  milestone: Milestone,
): Promise<void> {
  await saveMilestone(ctx, task.id, {
    ...milestone,
    status: MilestoneStatus.Complete,
    updatedAt: nowIso(),
  });
}

interface SliceLookup {
  readonly milestone: MilestoneWithChildren;
  readonly slice: SliceWithFeatures;
}

function findActiveSlice(milestones: ReadonlyArray<MilestoneWithChildren>): SliceLookup | null {
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

function findNextPendingSlice(
  milestones: ReadonlyArray<MilestoneWithChildren>,
): SliceLookup | null {
  for (const milestone of milestones) {
    for (const slice of milestone.slices) {
      if (slice.status === SliceStatus.Pending) {
        return {
          milestone,
          slice,
        };
      }
    }
  }
  return null;
}

//#endregion

//#region Slice classification

export interface SliceCompletionDecision {
  readonly kind: 'all_passed' | 'any_blocked' | 'in_progress' | 'empty';
}

export type { FeatureGroups };

export function classifySliceCompletion(groups: FeatureGroups): SliceCompletionDecision {
  const total =
    groups.idle.length +
    groups.implementing.length +
    groups.validating.length +
    groups.passed.length +
    groups.needsFix.length +
    groups.blocked.length;
  if (total === 0) {
    return {
      kind: 'empty',
    };
  }
  if (groups.passed.length === total) {
    return {
      kind: 'all_passed',
    };
  }
  const stillWorking =
    groups.idle.length +
    groups.implementing.length +
    groups.validating.length +
    groups.needsFix.length;
  if (stillWorking === 0 && groups.blocked.length > 0) {
    return {
      kind: 'any_blocked',
    };
  }
  return {
    kind: 'in_progress',
  };
}

//#endregion

//#region Slice handlers

async function activateNextSlice(
  deps: AutopilotDeps,
  taskCtx: TaskTickContext,
  next: SliceLookup,
): Promise<void> {
  const result = await activateSlice(deps.ctx, {
    parentTaskId: taskCtx.task.id,
    sliceId: next.slice.id,
    triage: true,
  });
  taskCtx.report.slicesActivated += 1;
  taskCtx.report.featuresTriaged += result.triaged.created.length;
}

async function handleSliceAllPassed(deps: AutopilotDeps, ctx: SliceContext): Promise<void> {
  await markSliceComplete(deps.ctx, ctx.task, ctx.slice);
  ctx.report.slicesCompleted += 1;
  if (milestoneIsFullyCompleteAfter(ctx.milestone, ctx.slice.id)) {
    await markMilestoneComplete(deps.ctx, ctx.task, ctx.milestone);
  }
  const refreshed = await getTaskHierarchy(deps.ctx, ctx.task.id);
  if (refreshed === null) {
    return;
  }
  const next = findNextPendingSlice(refreshed.milestones);
  if (next === null) {
    const completing = await setTaskAutopilotState(deps.ctx, ctx.task, AutopilotState.Completing);
    const completed = await setTaskHierarchyStatus(deps.ctx, completing, HierarchyStatus.Complete);
    await patchTaskAutopilot(deps.ctx, completed, {
      lifecycleStatus: TaskLifecycleStatus.Merged,
      autopilotState: AutopilotState.Inactive,
    });
    ctx.report.tasksCompleted += 1;
    return;
  }
  const activatingTask = await setTaskAutopilotState(deps.ctx, ctx.task, AutopilotState.Activating);
  await activateNextSlice(
    deps,
    {
      task: activatingTask,
      milestones: refreshed.milestones,
      report: ctx.report,
    },
    next,
  );
  await setTaskAutopilotState(deps.ctx, activatingTask, AutopilotState.Watching);
}

function milestoneIsFullyCompleteAfter(
  milestone: MilestoneWithChildren,
  justCompletedSliceId: string,
): boolean {
  for (const slice of milestone.slices) {
    if (slice.id === justCompletedSliceId) {
      continue;
    }
    if (slice.status !== SliceStatus.Complete) {
      return false;
    }
  }
  return true;
}

async function handleSliceBlocked(deps: AutopilotDeps, ctx: SliceContext): Promise<void> {
  await setTaskAutopilotState(deps.ctx, ctx.task, AutopilotState.Watching);
  await setTaskHierarchyStatus(deps.ctx, ctx.task, HierarchyStatus.Blocked);
  ctx.report.tasksBlocked += 1;
}

async function handleEmptySlice(deps: AutopilotDeps, ctx: SliceContext): Promise<void> {
  await handleSliceAllPassed(deps, ctx);
}

const sliceHandlers: Record<
  SliceCompletionDecision['kind'],
  (deps: AutopilotDeps, ctx: SliceContext) => Promise<void>
> = {
  all_passed: handleSliceAllPassed,
  any_blocked: handleSliceBlocked,
  in_progress: async () => {
    /* keep watching */
  },
  empty: handleEmptySlice,
};

//#endregion

//#region Tick body

async function tickWithActiveSlice(
  deps: AutopilotDeps,
  taskCtx: TaskTickContext,
  active: SliceLookup,
): Promise<void> {
  const groups = groupFeaturesByLoopState(active.slice.features);
  const decision = classifySliceCompletion(groups);
  const handler = sliceHandlers[decision.kind];
  await handler(deps, {
    task: taskCtx.task,
    milestone: active.milestone,
    slice: active.slice,
    report: taskCtx.report,
  });
}

async function tickWithoutActiveSlice(
  deps: AutopilotDeps,
  taskCtx: TaskTickContext,
): Promise<void> {
  const next = findNextPendingSlice(taskCtx.milestones);
  if (next === null) {
    const completing = await setTaskAutopilotState(
      deps.ctx,
      taskCtx.task,
      AutopilotState.Completing,
    );
    const completed = await setTaskHierarchyStatus(deps.ctx, completing, HierarchyStatus.Complete);
    await patchTaskAutopilot(deps.ctx, completed, {
      lifecycleStatus: TaskLifecycleStatus.Merged,
      autopilotState: AutopilotState.Inactive,
    });
    taskCtx.report.tasksCompleted += 1;
    return;
  }
  const activating = await setTaskAutopilotState(deps.ctx, taskCtx.task, AutopilotState.Activating);
  await activateNextSlice(
    deps,
    {
      task: activating,
      milestones: taskCtx.milestones,
      report: taskCtx.report,
    },
    next,
  );
  await setTaskAutopilotState(deps.ctx, activating, AutopilotState.Watching);
}

async function tickOneTask(
  deps: AutopilotDeps,
  task: Task,
  report: AutopilotTickReport,
): Promise<void> {
  const refreshedTask =
    task.autopilotState === AutopilotState.Inactive
      ? await setTaskAutopilotState(deps.ctx, task, AutopilotState.Watching)
      : task;
  const hierarchy = await getTaskHierarchy(deps.ctx, refreshedTask.id);
  if (hierarchy === null) {
    return;
  }
  const taskCtx: TaskTickContext = {
    task: refreshedTask,
    milestones: hierarchy.milestones,
    report,
  };
  const active = findActiveSlice(hierarchy.milestones);
  if (active === null) {
    await tickWithoutActiveSlice(deps, taskCtx);
    return;
  }
  await tickWithActiveSlice(deps, taskCtx, active);
}

//#endregion

//#region Public API

/**
 * Drives a single autopilot tick. Three passes:
 *
 *   1. **plan-pass** — spawn the planner subprocess for autopilot-enabled
 *      manual tasks that haven't yet been planned. No-op when
 *      `deps.startPlannerRun` is undefined (e.g. in tests).
 *   2. **implement-pass** — spawn the implementer subprocess for
 *      triaged features whose linked leaf task has no worktree. No-op
 *      when `deps.startImplementerRun` is undefined.
 *   3. **structured-tick** — for every autopilot-enabled structured
 *      task whose hierarchyStatus is `planning` or `active`, advance
 *      slice and milestone state machines, triage newly-activated
 *      slices, and emit `mission:statusChanged` events.
 */
export async function runAutopilotTick(deps: AutopilotDeps): Promise<AutopilotTickReport> {
  const report = emptyReport();
  const tasks = await listTasks(deps.ctx);
  await runPlanPass({
    deps,
    tasks,
    report,
  });
  await runImplementPass({
    deps,
    tasks,
    report,
  });
  for (const task of tasks) {
    if (!task.autopilotEnabled) {
      continue;
    }
    if (
      task.hierarchyStatus !== HierarchyStatus.Planning &&
      task.hierarchyStatus !== HierarchyStatus.Active
    ) {
      continue;
    }
    // Refresh from disk in case a previous iteration mutated this task.
    const fresh = await tryLoadTask(deps.ctx, task.id);
    if (fresh === null) {
      continue;
    }
    report.tasksScanned += 1;
    await tickOneTask(deps, fresh, report);
  }
  return report;
}

//#endregion
