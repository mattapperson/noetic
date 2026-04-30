import type { TaskStoreContext } from '../fs-store.js';
import { appendLog } from '../fs-store.js';
import { taskDirPaths } from '../paths.js';
import type { LogEntry } from '../schemas.js';
import { LogEntryKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface SteerTaskArgs {
  readonly taskId: string;
  readonly message: string;
}

export interface SteerTaskResult {
  readonly entry: LogEntry;
  readonly steeringPath: string;
}

//#endregion

//#region Helpers

function formatSteeringEntry(args: { ts: string; message: string }): string {
  return `\n## ${args.ts}\n\n${args.message}\n`;
}

//#endregion

//#region Public API

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
  const paths = taskDirPaths(ctx.projectRoot, args.taskId);
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
