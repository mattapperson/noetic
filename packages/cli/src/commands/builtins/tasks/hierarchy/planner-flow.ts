/**
 * Commit helpers for the planner runner's terminal tools.
 *
 * The legacy step-graph planner (`buildPlannerFlow`) is gone — the
 * runner now uses turn-based chat (see ../planner-runner.ts) with
 * `submit_hierarchy` / `abandon_planning` tools that delegate the
 * audit→state→event commit sequence to the helpers exported here.
 */

import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent, appendLog, loadTask, saveTask } from '../fs-store.js';
import { clearPlanner } from '../planner-state.js';
import type { Task } from '../schemas.js';
import { AutopilotState, EventKind, HierarchyStatus, LogEntryKind } from '../schemas.js';
import { persistTaskHierarchy } from './persist.js';
import type { TaskHierarchyInput } from './schemas.js';

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

//#endregion

//#region Public API

export interface CommitSuccessArgs {
  readonly storeCtx: TaskStoreContext;
  readonly taskId: string;
  readonly hierarchy: TaskHierarchyInput;
}

/**
 * Persist a planner-produced hierarchy and flip the task into Watching.
 * Order: audit log → hierarchy persist → task.json save → event → clear
 * sidecar.
 */
export async function commitSuccess(args: CommitSuccessArgs): Promise<void> {
  const ts = nowIso();
  await appendLog(args.storeCtx, {
    taskId: args.taskId,
    entry: {
      kind: LogEntryKind.System,
      ts,
      message: `planner completed: ${args.hierarchy.milestones.length} milestone(s) persisted`,
    },
  });
  await persistTaskHierarchy(args.storeCtx, args.taskId, args.hierarchy);
  const task = await loadTask(args.storeCtx, args.taskId);
  const next: Task = {
    ...task,
    hierarchyStatus: HierarchyStatus.Active,
    autopilotState: AutopilotState.Watching,
    lastAutopilotActivityAt: ts,
    updatedAt: ts,
    lastSeenAt: ts,
  };
  await saveTask(args.storeCtx, next);
  await appendEvent(args.storeCtx, {
    taskId: args.taskId,
    kind: EventKind.HierarchyStatusChanged,
    payload: {
      hierarchyStatus: HierarchyStatus.Active,
      milestoneCount: args.hierarchy.milestones.length,
    },
    ts,
  });
  await clearPlanner(args.storeCtx, args.taskId).catch(() => {
    /* swallow — sidecar will be evicted by the next launcher's pid check */
  });
}

export interface CommitFailureArgs {
  readonly storeCtx: TaskStoreContext;
  readonly taskId: string;
  readonly reason: string;
  readonly status: 'failed' | 'maxQuestions';
}

/**
 * Record a planner failure and flip the task back to Inactive. Order:
 * audit log → task.json save → event → clear sidecar.
 */
export async function commitFailure(args: CommitFailureArgs): Promise<void> {
  const ts = nowIso();
  await appendLog(args.storeCtx, {
    taskId: args.taskId,
    entry: {
      kind: LogEntryKind.System,
      ts,
      message: `planner ${args.status}: ${args.reason}`,
    },
  });
  const task = await loadTask(args.storeCtx, args.taskId);
  const next: Task = {
    ...task,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: ts,
    updatedAt: ts,
    lastSeenAt: ts,
  };
  await saveTask(args.storeCtx, next);
  await appendEvent(args.storeCtx, {
    taskId: args.taskId,
    kind: EventKind.TaskUpdated,
    payload: {
      autopilotState: AutopilotState.Inactive,
      plannerStatus: args.status,
      reason: args.reason,
      phase: 'exit',
    },
    ts,
  });
  await clearPlanner(args.storeCtx, args.taskId).catch(() => {
    /* swallow */
  });
}

//#endregion
