import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent, saveTask } from '../fs-store.js';
import type {
  InterviewQuestionEnvelope,
  InterviewResultLike,
  RunInterviewFn,
} from '../hierarchy/live-interview.js';
import { closeInterviewSession, ensureInterviewSession } from '../hierarchy/live-interview.js';
import type { PersistedHierarchy } from '../hierarchy/persist.js';
import { persistTaskHierarchy } from '../hierarchy/persist.js';
import type { Task } from '../schemas.js';
import { EventKind, HierarchyStatus } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

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

//#endregion

//#region Helpers

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

//#endregion

//#region Public API

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
