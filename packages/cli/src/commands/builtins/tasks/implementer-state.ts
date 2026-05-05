/**
 * Per-leaf-task implementer sidecar. The implementer launcher writes
 * `<leafTaskDir>/_implementer.json` when it spawns the implementation
 * agent subprocess; the runner clears it on exit; delete-guards and
 * pause/cancel surfaces read it to locate the live pid. Sidecar
 * placement (rather than embedding in `task.json`) keeps volatile
 * process state out of the canonical record. Mirrors `runner-state.ts`.
 */

import path from 'node:path';

import { z } from 'zod';

import { isEnoent } from './_fs-errors.js';
import type { TaskStoreContext } from './fs-store.js';
import { taskDirPaths, tempPath } from './paths.js';
import { TaskIdSchema } from './schemas.js';

//#region Schema

function randomSalt(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Identity tuple for the live implementer subprocess. `pidStarttime`
 * is the `ps -o lstart=` snapshot captured at spawn; re-read before
 * sending signals so we never misfire on a recycled pid.
 *
 * The implementer is per-feature, but lives under the *leaf* task's
 * directory. `parentTaskId` records the structured task that owns the
 * feature so the runner can locate the hierarchy file to mutate.
 */
export const ImplementerStateSchema = z.object({
  taskId: TaskIdSchema,
  parentTaskId: TaskIdSchema,
  featureId: z.string().min(1),
  sessionId: z.string().min(1),
  pid: z.number().int().positive(),
  pidStarttime: z.string().nullable(),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  startedAt: z.string(),
  pausedAt: z.string().nullable(),
  /**
   * Absolute path to the runner's IPC unix-domain socket. Populated by
   * the runner once it binds; the TUI reads this to connect for live
   * chat. Null until the runner has bound.
   */
  socketPath: z.string().nullish(),
});

export type ImplementerState = z.infer<typeof ImplementerStateSchema>;

//#endregion

//#region Helpers

function implementerPath(ctx: TaskStoreContext, taskId: string): string {
  const paths = taskDirPaths(ctx, taskId);
  return path.join(paths.dir, '_implementer.json');
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

export async function saveImplementer(
  ctx: TaskStoreContext,
  state: ImplementerState,
): Promise<void> {
  const validated = ImplementerStateSchema.parse(state);
  const target = implementerPath(ctx, validated.taskId);
  await atomicWrite(ctx, target, `${JSON.stringify(validated, null, 2)}\n`);
}

export async function loadImplementer(
  ctx: TaskStoreContext,
  taskId: string,
): Promise<ImplementerState | null> {
  TaskIdSchema.parse(taskId);
  const target = implementerPath(ctx, taskId);
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
  return ImplementerStateSchema.parse(JSON.parse(raw));
}

export async function clearImplementer(ctx: TaskStoreContext, taskId: string): Promise<void> {
  TaskIdSchema.parse(taskId);
  const target = implementerPath(ctx, taskId);
  await ctx.fs.rm(target, {
    force: true,
  });
}

//#endregion
