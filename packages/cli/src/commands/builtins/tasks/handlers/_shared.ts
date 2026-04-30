/**
 * Shared helpers for `noetic tasks` verb handlers. Each verb is a thin
 * wrapper around the lower-level FS / hierarchy primitives — these
 * helpers cover the common bits (id resolution, error formatting,
 * timestamps) so every handler stays small and focused.
 */

import type { TaskStoreContext } from '../fs-store.js';
import { loadTask } from '../fs-store.js';
import type { Task } from '../schemas.js';

//#region Helpers

/**
 * Resolve a task by exact id. Future revisions may accept a unique
 * prefix; today we delegate to the store's full-id loader so behaviour
 * stays predictable.
 */
export async function resolveTask(ctx: TaskStoreContext, idOrPrefix: string): Promise<Task> {
  return loadTask(ctx, idOrPrefix);
}

/** Format an unknown error into a user-facing single-line string. */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** ISO-8601 timestamp at the current instant, used by every mutating handler. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Resolve the project root for verb execution. Honours the explicit
 * `NOETIC_PROJECT_ROOT` env var first, then falls back to `process.cwd()`.
 * Throws if no usable value is available.
 */
export function requireProjectRoot(): string {
  const fromEnv = process.env.NOETIC_PROJECT_ROOT;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return fromEnv;
  }
  const cwd = process.cwd();
  if (cwd.length === 0) {
    throw new Error(
      'Unable to resolve project root: cwd is empty and NOETIC_PROJECT_ROOT is unset',
    );
  }
  return cwd;
}

//#endregion
