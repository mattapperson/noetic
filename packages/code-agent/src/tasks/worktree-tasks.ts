/**
 * Worktree → Task helpers for the FS-backed task store.
 *
 * Both `/agent-ci` and the `agent` tool's worktree-isolated spawn path need
 * to materialize a `Task` record for a given git worktree pair. The id is
 * derived deterministically from `(projectRoot, worktreePath)` so repeated
 * calls land on the same `T-<10>` slot. Existing records have their git
 * pointers refreshed; missing records are seeded with default lifecycle.
 */

import type { TaskStoreContext } from './fs-store.js';
import { saveTask, tryLoadTask } from './fs-store.js';
import type { Task } from './schemas.js';
import {
  AutopilotState,
  ID_LENGTH,
  IdPrefix,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from './schemas.js';

//#region Public API

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Deterministic FS-shaped task id for a worktree pair. The hash domain is
 * `(projectRoot, worktreePath)` so the same worktree always lands on the
 * same `T-<10>` id. Uses SHA-256 via Web Crypto so the SDK stays free of
 * `node:crypto`.
 */
export async function deterministicWorktreeTaskId(
  projectRoot: string,
  worktreePath: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const input = new Uint8Array([
    ...encoder.encode(projectRoot),
    0,
    ...encoder.encode(worktreePath),
  ]);
  const digestBuffer = await globalThis.crypto.subtle.digest('SHA-256', input);
  const digest = bytesToBase64Url(new Uint8Array(digestBuffer));
  return `${IdPrefix.Task}-${digest.slice(0, ID_LENGTH)}`;
}

export interface EnsureWorktreeTaskArgs {
  readonly ctx: TaskStoreContext;
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly headSha?: string | null;
  readonly now?: string;
}

/**
 * Idempotent: load an existing task or persist a fresh worktree-source
 * record. Newly-created records start in `not_started`; existing records
 * retain their lifecycle state so re-running on a `needs_changes` task
 * simply refreshes the git pointers.
 */
export async function ensureWorktreeTask(args: EnsureWorktreeTaskArgs): Promise<Task> {
  const now = args.now ?? new Date().toISOString();
  const taskId = await deterministicWorktreeTaskId(args.projectRoot, args.worktreePath);
  const existing = await tryLoadTask(args.ctx, taskId);
  if (existing !== null) {
    const next: Task = {
      ...existing,
      branch: args.branch,
      headSha: args.headSha ?? existing.headSha,
      worktreePath: args.worktreePath,
      updatedAt: now,
      lastSeenAt: now,
    };
    await saveTask(args.ctx, next);
    return next;
  }
  const fresh: Task = {
    id: taskId,
    source: TaskSource.Worktree,
    title: args.branch ?? args.worktreePath,
    projectRoot: args.projectRoot,
    worktreePath: args.worktreePath,
    branch: args.branch,
    headSha: args.headSha ?? null,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: false,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
  await saveTask(args.ctx, fresh);
  return fresh;
}

//#endregion
