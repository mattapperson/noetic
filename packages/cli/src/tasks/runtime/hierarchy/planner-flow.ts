/**
 * Commit helpers for the planner runner's terminal tools.
 *
 * The legacy step-graph planner (`buildPlannerFlow`) is gone — the
 * runner now uses turn-based chat (see ../planner-runner.ts) with
 * `submit_hierarchy` / `abandon_planning` tools that delegate the
 * audit→state→event commit sequence to the helpers exported here.
 */

import type { Task, TaskHierarchyInput } from '@noetic-tools/code-agent/tasks/schema';
import {
  AutopilotState,
  EventKind,
  HierarchyStatus,
  LogEntryKind,
} from '@noetic-tools/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic-tools/code-agent/tasks/store/fs-node';
import { appendEvent, appendLog, loadTask, saveTask } from '@noetic-tools/code-agent/tasks/store/fs-node';
import { persistTaskHierarchy } from './persist.js';

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
  // Handle lifecycle is tracked by the subprocess adapter's manifest,
  // which the runner process cleans up on exit. No sidecar to clear.
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
  // Handle lifecycle is tracked by the subprocess adapter's manifest;
  // the runner clears its manifest entry on process exit.
}

//#endregion
