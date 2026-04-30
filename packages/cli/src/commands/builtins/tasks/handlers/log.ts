import type { TaskStoreContext } from '../fs-store.js';
import { appendLog } from '../fs-store.js';
import type { LogEntry } from '../schemas.js';
import { LogEntryKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface LogTaskArgs {
  readonly taskId: string;
  readonly message: string;
}

export interface LogTaskResult {
  readonly entry: LogEntry;
}

//#endregion

//#region Public API

/**
 * Append a freeform `log`-kind entry to the task's audit trail. Use
 * `commentTaskHandler` for human-authored remarks and `steerTaskHandler`
 * for steering directives that should also land in `steering.md`.
 */
export async function logTaskHandler(
  ctx: TaskStoreContext,
  args: LogTaskArgs,
): Promise<LogTaskResult> {
  await resolveTask(ctx, args.taskId);
  const entry: LogEntry = {
    kind: LogEntryKind.Log,
    ts: nowIso(),
    message: args.message,
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
