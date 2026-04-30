import type { Signaller } from '../agent-ci-control.js';
import { emitTaskEvent } from '../events.js';
import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent, listTasks, saveTask, tryLoadTask } from '../fs-store.js';
import type { Task } from '../schemas.js';
import { AutopilotState, EventKind, HierarchyStatus, TaskLifecycleStatus } from '../schemas.js';
import { activateSlice } from './activation.js';
import { getTaskHierarchy } from './aggregate.js';
import type {
  Feature,
  Milestone,
  MilestoneWithChildren,
  Slice,
  SliceWithFeatures,
} from './schemas.js';
import { FeatureLoopState, MilestoneStatus, SliceStatus } from './schemas.js';
import { saveMilestone, saveSlice } from './store.js';

//#region Types

/** Long-lived dependencies shared by the autopilot/validator/health daemons. */
export interface AutopilotDeps {
  readonly ctx: TaskStoreContext;
  readonly signaller: Signaller;
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
  };
}

function groupFeaturesByLoopState(features: ReadonlyArray<Feature>): FeatureGroups {
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
  const next: Task = {
    ...task,
    autopilotState: patch.autopilotState ?? task.autopilotState,
    hierarchyStatus:
      patch.hierarchyStatus !== undefined ? patch.hierarchyStatus : task.hierarchyStatus,
    lifecycleStatus: patch.lifecycleStatus ?? task.lifecycleStatus,
    lastAutopilotActivityAt: nowIso(),
    updatedAt: nowIso(),
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
  const event = await appendEvent(ctx, {
    kind: EventKind.HierarchyStatusChanged,
    taskId: task.id,
    payload: {
      hierarchyStatus: next,
    },
    ts: nowIso(),
  });
  emitTaskEvent(event);
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

function _milestoneIsFullyComplete(milestone: MilestoneWithChildren): boolean {
  if (milestone.slices.length === 0) {
    return false;
  }
  return milestone.slices.every((slice) => slice.status === SliceStatus.Complete);
}

//#endregion

//#region Slice classification

interface SliceCompletionDecision {
  readonly kind: 'all_passed' | 'any_blocked' | 'in_progress' | 'empty';
}

function classifySliceCompletion(groups: FeatureGroups): SliceCompletionDecision {
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
 * Drives a single autopilot tick across every autopilot-enabled
 * structured task whose hierarchyStatus is `planning` or `active`.
 * Advances slice and milestone state machines, triages newly-activated
 * slices, and emits a `mission:statusChanged` event whenever the task's
 * hierarchyStatus transitions.
 */
export async function runAutopilotTick(deps: AutopilotDeps): Promise<AutopilotTickReport> {
  const report = emptyReport();
  const tasks = await listTasks(deps.ctx);
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
