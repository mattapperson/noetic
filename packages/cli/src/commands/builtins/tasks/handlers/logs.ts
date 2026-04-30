import type { TaskStoreContext } from '../fs-store.js';
import { tailLog } from '../fs-store.js';
import type { LogEntry } from '../schemas.js';
import { resolveTask } from './_shared.js';

//#region Types

export interface LogsTaskArgs {
  readonly taskId: string;
  /** Number of trailing entries to return (default 50). */
  readonly n?: number;
}

export interface LogsTaskResult {
  readonly entries: LogEntry[];
}

//#endregion

//#region Public API

/** Tail the last `n` entries of a task's `log.jsonl`. */
export async function logsTaskHandler(
  ctx: TaskStoreContext,
  args: LogsTaskArgs,
): Promise<LogsTaskResult> {
  await resolveTask(ctx, args.taskId);
  const entries = await tailLog(ctx, {
    taskId: args.taskId,
    n: args.n,
  });
  return {
    entries,
  };
}

//#endregion
