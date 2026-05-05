import type { LogEntry, Task } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { tailLog } from '@noetic/code-agent/tasks/store/fs-node';
import { getTaskHierarchy } from '../hierarchy/aggregate.js';
import type { TaskHierarchy } from '../hierarchy/schemas.js';
import { resolveTask } from './_shared.js';

//#region Types

export interface ShowTaskArgs {
  readonly taskId: string;
  /** How many trailing log entries to include (default 20). */
  readonly logTail?: number;
}

export interface ShowTaskResult {
  readonly task: Task;
  readonly recentLog: LogEntry[];
  readonly hierarchy: TaskHierarchy | null;
}

//#endregion

//#region Public API

/**
 * Read-only view of a task: the canonical record, the most recent log
 * entries, and the hierarchy summary if the task has one.
 */
export async function showTaskHandler(
  ctx: TaskStoreContext,
  args: ShowTaskArgs,
): Promise<ShowTaskResult> {
  const task = await resolveTask(ctx, args.taskId);
  const recentLog = await tailLog(ctx, {
    taskId: task.id,
    n: args.logTail ?? 20,
  });
  const hierarchy = await getTaskHierarchy(ctx, task.id);
  return {
    task,
    recentLog,
    hierarchy,
  };
}

//#endregion
