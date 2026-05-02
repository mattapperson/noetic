/**
 * Resolve a task → IPC socket so the TUI can open a chat with whichever
 * agent is currently active on that task.
 *
 * Priority order:
 *   1. planner sidecar (`_planner.json`) — present iff a planner runner
 *      is bound to this task.
 *   2. implementer sidecar (`_implementer.json`) — present iff an
 *      implementer runner is bound to this leaf task.
 *
 * Returns `null` when no live agent is bound (e.g. autopilot is paused
 * or the task has terminated).
 */

import type { TaskStoreContext } from './fs-store.js';
import { loadImplementer } from './implementer-state.js';
import { PlannerSpawnError, PlannerSpawnErrorCode, startPlannerRun } from './planner-launcher.js';
import { loadPlanner } from './planner-state.js';

//#region Types

export interface ChatTarget {
  readonly socketPath: string;
  readonly role: 'planner' | 'implementer';
  readonly roleLabel: string;
}

export interface WaitForChatTargetOptions {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface EnsureChatTargetOptions {
  /** Invoked once we transition from "checking" to "spawning + polling". */
  readonly onSpawning?: () => void;
  /** Total time to wait for the runner to bind its IPC socket. */
  readonly timeoutMs?: number;
  /** Interval between polls while waiting. */
  readonly pollIntervalMs?: number;
  /** Override for tests — defaults to the real {@link startPlannerRun}. */
  readonly startPlannerRunFn?: typeof startPlannerRun;
}

//#endregion

//#region Public API

export async function resolveChatTarget(
  ctx: TaskStoreContext,
  taskId: string,
): Promise<ChatTarget | null> {
  const planner = await loadPlanner(ctx, taskId);
  if (planner !== null && planner.socketPath !== null && planner.socketPath !== undefined) {
    return {
      socketPath: planner.socketPath,
      role: 'planner',
      roleLabel: 'planner',
    };
  }
  const implementer = await loadImplementer(ctx, taskId);
  if (
    implementer !== null &&
    implementer.socketPath !== null &&
    implementer.socketPath !== undefined
  ) {
    return {
      socketPath: implementer.socketPath,
      role: 'implementer',
      roleLabel: `implementer · ${implementer.featureId}`,
    };
  }
  return null;
}

/**
 * Poll {@link resolveChatTarget} until it returns a non-null target or the
 * timeout elapses. Used after spawning a runner so the TUI can wait for
 * the subprocess to bind its IPC socket before connecting.
 */
export async function waitForChatTarget(
  ctx: TaskStoreContext,
  taskId: string,
  opts: WaitForChatTargetOptions,
): Promise<ChatTarget | null> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const target = await resolveChatTarget(ctx, taskId);
    if (target !== null) {
      return target;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, opts.pollIntervalMs));
  }
  return null;
}

/**
 * Resolve a chat target for `taskId`, spawning a planner runner on
 * demand if no agent is bound yet. Hides the spawn-then-poll sequence
 * (and the {@link PlannerSpawnError} it can raise) from callers so the
 * TUI doesn't need to import planner-launcher internals.
 *
 * Returns `null` only if the spawn truly failed or the runner did not
 * bind its IPC socket within the timeout.
 */
export async function ensureChatTarget(
  ctx: TaskStoreContext,
  taskId: string,
  opts: EnsureChatTargetOptions = {},
): Promise<ChatTarget | null> {
  const initial = await resolveChatTarget(ctx, taskId);
  if (initial !== null) {
    return initial;
  }
  opts.onSpawning?.();
  const start = opts.startPlannerRunFn ?? startPlannerRun;
  try {
    await start({
      ctx,
      taskId,
    });
  } catch (err) {
    // `already-attached` means a planner is in flight (sidecar exists,
    // pid alive) but hasn't bound the socket yet — fall through to poll.
    const alreadyAttached =
      err instanceof PlannerSpawnError && err.code === PlannerSpawnErrorCode.AlreadyAttached;
    if (!alreadyAttached) {
      return null;
    }
  }
  return waitForChatTarget(ctx, taskId, {
    timeoutMs: opts.timeoutMs ?? 15e3,
    pollIntervalMs: opts.pollIntervalMs ?? 250,
  });
}

//#endregion
