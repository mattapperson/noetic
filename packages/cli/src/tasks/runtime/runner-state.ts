/**
 * Per-task runner state file. Writes the agent-ci runner's pid + identity
 * tuple to `<taskDir>/_runner.json`. The launcher creates it; the runner
 * clears it on exit; control surfaces (pause / unpause / cancel) read it
 * to locate the live process. Kept in a sidecar file (not embedded in
 * `task.json`) so volatile process state never pollutes the canonical
 * task record.
 */

import * as path from '@noetic/code-agent/tasks/path-utils';
import { TaskIdSchema } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { isEnoent, taskDirPaths, tempPath } from '@noetic/code-agent/tasks/store/fs-node';
import { z } from 'zod';

//#region Schema

/**
 * Random salt for write-temp-then-rename. Local copy keeps the runner-state
 * module self-contained (no exports leak from `fs-store.ts`).
 */
function randomSalt(): string {
  // 6 bytes → 8 base64url chars; collision-resistant for concurrent writers.
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Sidecar describing the live agent-ci runner. `pidStarttime` is the
 * `ps -o lstart=` snapshot we captured at spawn; we re-read it before
 * sending signals so we never accidentally signal a recycled pid.
 */
export const RunnerStateSchema = z.object({
  taskId: TaskIdSchema,
  sessionId: z.string().min(1),
  pid: z.number().int().positive(),
  pidStarttime: z.string().nullable(),
  workflow: z.string().min(1),
  startedAt: z.string(),
  pausedAt: z.string().nullable(),
});

export type RunnerState = z.infer<typeof RunnerStateSchema>;

//#endregion

//#region Helpers

function runnerPath(ctx: TaskStoreContext, taskId: string): string {
  const paths = taskDirPaths(ctx, taskId);
  return path.join(paths.dir, '_runner.json');
}

async function atomicWrite(ctx: TaskStoreContext, target: string, content: string): Promise<void> {
  await ctx.fs.mkdir(path.dirname(target));
  const tmp = tempPath(target, randomSalt());
  await ctx.fs.writeFile(tmp, content);
  try {
    await ctx.fs.rename(tmp, target);
  } catch (err) {
    await ctx.fs.rm(tmp, {
      force: true,
    });
    throw err;
  }
}

//#endregion

//#region Public API

/** Persist the runner state for `taskId`. Atomic write-then-rename. */
export async function saveRunner(ctx: TaskStoreContext, state: RunnerState): Promise<void> {
  const validated = RunnerStateSchema.parse(state);
  const target = runnerPath(ctx, validated.taskId);
  await atomicWrite(ctx, target, `${JSON.stringify(validated, null, 2)}\n`);
}

/** Load runner state for `taskId`, or null if no runner is recorded. */
export async function loadRunner(
  ctx: TaskStoreContext,
  taskId: string,
): Promise<RunnerState | null> {
  TaskIdSchema.parse(taskId);
  const target = runnerPath(ctx, taskId);
  let raw: string;
  try {
    raw = await ctx.fs.readFileText(target);
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }
  if (raw.length === 0) {
    return null;
  }
  return RunnerStateSchema.parse(JSON.parse(raw));
}

/** Remove the runner sidecar. No-op if it does not exist. */
export async function clearRunner(ctx: TaskStoreContext, taskId: string): Promise<void> {
  TaskIdSchema.parse(taskId);
  const target = runnerPath(ctx, taskId);
  await ctx.fs.rm(target, {
    force: true,
  });
}

/** Update the `pausedAt` field. Throws if no runner exists. */
export async function setPausedAt(
  ctx: TaskStoreContext,
  taskId: string,
  pausedAt: string | null,
): Promise<RunnerState> {
  const existing = await loadRunner(ctx, taskId);
  if (existing === null) {
    throw new Error(`No runner state recorded for task ${taskId}`);
  }
  const next: RunnerState = {
    ...existing,
    pausedAt,
  };
  await saveRunner(ctx, next);
  return next;
}

//#endregion
