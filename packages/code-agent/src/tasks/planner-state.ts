/**
 * Per-task planner sidecar. The planner launcher writes
 * `<taskDir>/_planner.json` when it spawns the autospec planner
 * subprocess; the runner clears it on exit; delete-guards and
 * pause/cancel surfaces read it to locate the live pid. Mirrors
 * `runner-state.ts` and `implementer-state.ts` so the lifecycle
 * shape stays uniform across runner kinds.
 */

import { z } from 'zod';

import { isEnoent } from './_fs-errors.js';
import type { TaskStoreContext } from './fs-store.js';
import * as path from './path-utils.js';
import { taskDirPaths, tempPath } from './paths.js';
import { randomBase64Url } from './random.js';
import { TaskIdSchema } from './schemas.js';

//#region Schema

function randomSalt(): string {
  return randomBase64Url(6);
}

/**
 * Identity tuple for the live planner subprocess. `pidStarttime` is
 * the `ps -o lstart=` snapshot captured at spawn; re-read before
 * sending signals so we never misfire on a recycled pid.
 */
export const PlannerStateSchema = z.object({
  taskId: TaskIdSchema,
  sessionId: z.string().min(1),
  pid: z.number().int().positive(),
  pidStarttime: z.string().nullable(),
  startedAt: z.string(),
  pausedAt: z.string().nullable(),
  /**
   * Absolute path to the runner's IPC unix-domain socket. Populated by the
   * runner once it binds; the TUI reads this to connect for live chat.
   * Null until the runner has bound (e.g. between launcher write and
   * runner startup).
   */
  socketPath: z.string().nullish(),
});

export type PlannerState = z.infer<typeof PlannerStateSchema>;

//#endregion

//#region Helpers

function plannerPath(ctx: TaskStoreContext, taskId: string): string {
  const paths = taskDirPaths(ctx, taskId);
  return path.join(paths.dir, '_planner.json');
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

export async function savePlanner(ctx: TaskStoreContext, state: PlannerState): Promise<void> {
  const validated = PlannerStateSchema.parse(state);
  const target = plannerPath(ctx, validated.taskId);
  await atomicWrite(ctx, target, `${JSON.stringify(validated, null, 2)}\n`);
}

export async function loadPlanner(
  ctx: TaskStoreContext,
  taskId: string,
): Promise<PlannerState | null> {
  TaskIdSchema.parse(taskId);
  const target = plannerPath(ctx, taskId);
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
  return PlannerStateSchema.parse(JSON.parse(raw));
}

export async function clearPlanner(ctx: TaskStoreContext, taskId: string): Promise<void> {
  TaskIdSchema.parse(taskId);
  const target = plannerPath(ctx, taskId);
  await ctx.fs.rm(target, {
    force: true,
  });
}

//#endregion
