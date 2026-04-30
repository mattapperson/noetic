import type { TaskStoreContext } from '../fs-store.js';
import { appendLog } from '../fs-store.js';
import type { LogEntry } from '../schemas.js';
import { LogEntryKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface CommentTaskArgs {
  readonly taskId: string;
  readonly message: string;
}

export interface CommentTaskResult {
  readonly entry: LogEntry;
}

//#endregion

//#region Public API

/** Append a `comment`-kind log entry to a task's audit trail. */
export async function commentTaskHandler(
  ctx: TaskStoreContext,
  args: CommentTaskArgs,
): Promise<CommentTaskResult> {
  await resolveTask(ctx, args.taskId);
  const trimmed = args.message.trim();
  if (trimmed.length === 0) {
    throw new Error('Comment message must not be empty');
  }
  const entry: LogEntry = {
    kind: LogEntryKind.Comment,
    ts: nowIso(),
    message: trimmed,
  };
  await appendLog(ctx, {
    taskId: args.taskId,
    entry,
  });
  return {
    entry,
  };
}

//#endregion
