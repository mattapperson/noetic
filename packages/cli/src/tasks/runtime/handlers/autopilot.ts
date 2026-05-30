/**
 * Agent-loop orchestration handlers: autopilot, steer, plan.
 */

import type { LogEntry, Task } from '@noetic-tools/code-agent/tasks/schema';
import {
  AutopilotState,
  EventKind,
  HierarchyStatus,
  LogEntryKind,
} from '@noetic-tools/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic-tools/code-agent/tasks/store/fs-node';
import {
  appendEvent,
  appendLog,
  saveTask,
  taskDirPaths,
} from '@noetic-tools/code-agent/tasks/store/fs-node';
import type {
  InterviewQuestionEnvelope,
  InterviewResultLike,
  RunInterviewFn,
} from '../hierarchy/live-interview.js';
import { closeInterviewSession, ensureInterviewSession } from '../hierarchy/live-interview.js';
import type { PersistedHierarchy } from '../hierarchy/persist.js';
import { persistTaskHierarchy } from '../hierarchy/persist.js';
import { nowIso, resolveTask } from './_shared.js';

//#region autopilot

export interface AutopilotArgs {
  readonly taskId: string;
  readonly enabled: boolean;
}

export interface AutopilotResult {
  readonly task: Task;
  readonly previousEnabled: boolean;
}

/**
 * Flip a task's `autopilotEnabled` flag. Disabling resets the
 * autopilot state machine to `inactive` so the daemon doesn't pick
 * the task back up; enabling moves the task into `watching` so the
 * autopilot tick will consider it on the next pass.
 */
export async function autopilotHandler(
  ctx: TaskStoreContext,
  args: AutopilotArgs,
): Promise<AutopilotResult> {
  const existing = await resolveTask(ctx, args.taskId);
  const previousEnabled = existing.autopilotEnabled;
  if (previousEnabled === args.enabled) {
    return {
      task: existing,
      previousEnabled,
    };
  }
  const ts = nowIso();
  const next: Task = {
    ...existing,
    autopilotEnabled: args.enabled,
    autopilotState: args.enabled ? AutopilotState.Watching : AutopilotState.Inactive,
    lastAutopilotActivityAt: args.enabled ? ts : existing.lastAutopilotActivityAt,
    updatedAt: ts,
  };
  await saveTask(ctx, next);
  await appendEvent(ctx, {
    taskId: next.id,
    kind: EventKind.TaskUpdated,
    payload: {
      autopilotEnabled: next.autopilotEnabled,
      autopilotState: next.autopilotState,
    },
    ts,
  });
  return {
    task: next,
    previousEnabled,
  };
}

//#endregion

//#region steer

export interface SteerTaskArgs {
  readonly taskId: string;
  readonly message: string;
}

export interface SteerTaskResult {
  readonly entry: LogEntry;
  readonly steeringPath: string;
}

function formatSteeringEntry(args: { ts: string; message: string }): string {
  return `\n## ${args.ts}\n\n${args.message}\n`;
}

/**
 * Record a steering directive: append a `steer`-kind log entry AND
 * grow the task's `steering.md` so the agent has a single canonical
 * file to read for accumulated guidance.
 */
export async function steerTaskHandler(
  ctx: TaskStoreContext,
  args: SteerTaskArgs,
): Promise<SteerTaskResult> {
  await resolveTask(ctx, args.taskId);
  const trimmed = args.message.trim();
  if (trimmed.length === 0) {
    throw new Error('Steering message must not be empty');
  }
  const ts = nowIso();
  const entry: LogEntry = {
    kind: LogEntryKind.Steer,
    ts,
    message: trimmed,
  };
  await appendLog(ctx, {
    taskId: args.taskId,
    entry,
  });
  const paths = taskDirPaths(ctx, args.taskId);
  await ctx.fs.mkdir(paths.dir);
  await ctx.fs.appendFile(
    paths.steering,
    formatSteeringEntry({
      ts,
      message: trimmed,
    }),
  );
  return {
    entry,
    steeringPath: paths.steering,
  };
}

//#endregion

//#region plan

export interface PlanTaskArgs {
  readonly taskId: string;
  /**
   * Driver that runs the live interview. Production callers wire this
   * to `createLiveRunInterview()`; tests pass a stub returning a
   * canned `TaskHierarchyInput`.
   */
  readonly runInterview: RunInterviewFn;
}

export type PlanTaskResult =
  | {
      readonly status: 'complete';
      readonly task: Task;
      readonly persisted: PersistedHierarchy;
    }
  | {
      readonly status: 'incomplete';
      readonly task: Task;
      readonly lastQuestion?: InterviewQuestionEnvelope;
      readonly reason?: string;
    };

async function markPlanning(ctx: TaskStoreContext, task: Task, ts: string): Promise<Task> {
  const next: Task = {
    ...task,
    hierarchyStatus: HierarchyStatus.Planning,
    updatedAt: ts,
  };
  await saveTask(ctx, next);
  await appendEvent(ctx, {
    taskId: next.id,
    kind: EventKind.HierarchyStatusChanged,
    payload: {
      hierarchyStatus: HierarchyStatus.Planning,
    },
    ts,
  });
  return next;
}

async function markActive(ctx: TaskStoreContext, task: Task, ts: string): Promise<Task> {
  const next: Task = {
    ...task,
    hierarchyStatus: HierarchyStatus.Active,
    updatedAt: ts,
  };
  await saveTask(ctx, next);
  await appendEvent(ctx, {
    taskId: next.id,
    kind: EventKind.HierarchyStatusChanged,
    payload: {
      hierarchyStatus: HierarchyStatus.Active,
    },
    ts,
  });
  return next;
}

/**
 * Drive the live interview flow for a task. The handler stamps
 * `hierarchyStatus = 'planning'` upfront so any UI surface knows the
 * task is mid-interview, then either persists the resulting
 * hierarchy and flips status to `active`, or returns an
 * `incomplete` result if the interview hit its question budget.
 */
export async function planTaskHandler(
  ctx: TaskStoreContext,
  args: PlanTaskArgs,
): Promise<PlanTaskResult> {
  const existing = await resolveTask(ctx, args.taskId);
  const startTs = nowIso();
  const updated = await markPlanning(ctx, existing, startTs);
  const session = await ensureInterviewSession(ctx, args.taskId);
  const result: InterviewResultLike = await args.runInterview();

  if (result.status === 'maxQuestions') {
    await closeInterviewSession(ctx, {
      taskId: args.taskId,
      sessionId: session.id,
      status: 'cancelled',
    });
    return {
      status: 'incomplete',
      task: updated,
      lastQuestion: result.lastQuestion,
      reason: result.reason,
    };
  }

  const persisted = await persistTaskHierarchy(ctx, args.taskId, result.envelope);
  await closeInterviewSession(ctx, {
    taskId: args.taskId,
    sessionId: session.id,
    status: 'complete',
  });
  const finalTask = await markActive(ctx, updated, nowIso());
  return {
    status: 'complete',
    task: finalTask,
    persisted,
  };
}

//#endregion
