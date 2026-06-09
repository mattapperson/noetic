/**
 * Custom memory layer that tracks per-task planner-attempt counts and gates
 * the autopilot's plan-pass spawn budget.
 *
 * Scope: `'resource'` (one attempt-map per project root). State persists
 * to `<projectRoot>/.noetic/tasks/_planner-attempts.json` via `ctx.fs`
 * so the budget survives daemon restarts — the prior bug burned ~3
 * planner spawns in 3 minutes because every autopilot tick re-fired with
 * no awareness of prior failures.
 *
 * The layer does not surface anything to the LLM (no `recall`); it is a
 * code-only state container exposed via `ctx.memory['planner-attempts']`.
 *
 * `recordAttempt(taskId)` is idempotent for the "spawned but result not yet
 * known" semantics: callers invoke it eagerly on spawn, then the next plan
 * pass observes the count via `snapshot`. If the planner ultimately
 * succeeds, `clearAttempts(taskId)` resets the count so a future re-plan
 * is unbudgeted.
 */

import type { ExecutionContext, MemoryLayer } from '@noetic-tools/core';
import { layerData, layerFn, Slot } from '@noetic-tools/core';
import { z } from 'zod';

import { isEnoent } from '../_fs-errors.js';

//#region Constants

export const PLANNER_ATTEMPT_LAYER_ID = 'planner-attempts';

/** Maximum planner spawns per task before the autopilot stops re-firing. */
export const MAX_PLANNER_ATTEMPTS = 3;

//#endregion

//#region Schema

const PlannerAttemptStateSchema = z.record(z.string(), z.number().int().nonnegative());

export type PlannerAttemptState = z.infer<typeof PlannerAttemptStateSchema>;

//#endregion

//#region Helpers

export function persistFilePath(projectRoot: string): string {
  return `${projectRoot}/.noetic/tasks/_planner-attempts.json`;
}

/**
 * Read the persisted planner-attempt counts from disk via an FsAdapter.
 * Used by both the layer's `init` hook (with an `ExecutionContext`) and
 * by `autopilot.ts` (with a `TaskStoreContext`), so the path/parse logic
 * lives in one place. Missing file or schema-mismatched payload → empty
 * map; other errors propagate so callers can surface real I/O issues.
 */
export async function readPlannerAttemptsFromDisk(args: {
  fs: {
    readFileText(path: string): Promise<string>;
  };
  projectRoot: string;
}): Promise<PlannerAttemptState> {
  const path = persistFilePath(args.projectRoot);
  try {
    const text = await args.fs.readFileText(path);
    if (text.length === 0) {
      return {};
    }
    const parsed = PlannerAttemptStateSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      return {};
    }
    return parsed.data;
  } catch (err) {
    if (isEnoent(err)) {
      return {};
    }
    throw err;
  }
}

async function readFromDisk(args: {
  ctx: ExecutionContext;
  projectRoot: string;
}): Promise<PlannerAttemptState> {
  return readPlannerAttemptsFromDisk({
    fs: args.ctx.fs,
    projectRoot: args.projectRoot,
  });
}

async function writeToDisk(args: {
  ctx: ExecutionContext;
  projectRoot: string;
  state: PlannerAttemptState;
}): Promise<void> {
  const target = persistFilePath(args.projectRoot);
  const parent = target.slice(0, target.lastIndexOf('/'));
  await args.ctx.fs.mkdir(parent);
  // Temp+rename so readers never observe a half-written file. The
  // rename is atomic on POSIX.
  const tmp = `${target}.tmp.${Date.now().toString(36)}`;
  await args.ctx.fs.writeFile(tmp, JSON.stringify(args.state, null, 2));
  try {
    await args.ctx.fs.rename(tmp, target);
  } catch (err) {
    await args.ctx.fs.rm(tmp, {
      force: true,
    });
    throw err;
  }
}

//#endregion

//#region Public API

export interface PlannerAttemptLayerOpts {
  readonly projectRoot: string;
  /** Override the default budget — primarily a test seam. */
  readonly maxAttempts?: number;
}

export interface PlannerAttemptSnapshot {
  readonly attempts: PlannerAttemptState;
  readonly maxAttempts: number;
}

/** Returns true when `taskId` has remaining budget under `state`. */
export function hasBudgetRemaining(args: {
  state: PlannerAttemptState;
  maxAttempts: number;
  taskId: string;
}): boolean {
  const current = args.state[args.taskId] ?? 0;
  return current < args.maxAttempts;
}

export function createPlannerAttemptLayer(
  opts: PlannerAttemptLayerOpts,
): MemoryLayer<PlannerAttemptState> {
  const maxAttempts = opts.maxAttempts ?? MAX_PLANNER_ATTEMPTS;
  return {
    id: PLANNER_ATTEMPT_LAYER_ID,
    name: 'Planner Attempt Counter',
    slot: Slot.REMINDER,
    scope: 'resource',
    budget: {
      min: 0,
      max: 0,
    },
    provides: {
      snapshot: layerData<PlannerAttemptSnapshot, PlannerAttemptState>({
        read: (state) => ({
          attempts: state,
          maxAttempts,
        }),
      }),
      recordAttempt: layerFn<
        {
          taskId: string;
        },
        number,
        PlannerAttemptState
      >({
        description: 'Increment the planner-attempt count for a task and return the new count.',
        input: z.object({
          taskId: z.string(),
        }),
        output: z.number().int().nonnegative(),
        execute: async (args, state, ctx) => {
          const next = {
            ...state,
            [args.taskId]: (state[args.taskId] ?? 0) + 1,
          };
          await writeToDisk({
            ctx,
            projectRoot: opts.projectRoot,
            state: next,
          });
          return {
            result: next[args.taskId] ?? 0,
            state: next,
          };
        },
      }),
      clearAttempts: layerFn<
        {
          taskId: string;
        },
        void,
        PlannerAttemptState
      >({
        description: 'Reset the planner-attempt count for a task (use after a successful plan).',
        input: z.object({
          taskId: z.string(),
        }),
        output: z.void(),
        execute: async (args, state, ctx) => {
          if (state[args.taskId] === undefined) {
            return {
              result: undefined,
              state,
            };
          }
          const next = {
            ...state,
          };
          delete next[args.taskId];
          await writeToDisk({
            ctx,
            projectRoot: opts.projectRoot,
            state: next,
          });
          return {
            result: undefined,
            state: next,
          };
        },
      }),
    },
    hooks: {
      async init({ ctx }) {
        const state = await readFromDisk({
          ctx,
          projectRoot: opts.projectRoot,
        });
        return {
          state,
        };
      },
    },
  };
}

//#endregion
