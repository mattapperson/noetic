/**
 * Resolve a task → IPC socket so the TUI can open a chat with whichever
 * agent is currently active on that task.
 *
 * Priority order:
 *   1. planner handle — present iff a planner runner's live subprocess
 *      handle is in the adapter's manifest AND its socket is reachable
 *      on disk.
 *   2. implementer handle — present iff an implementer runner is bound
 *      to this leaf task AND its socket is reachable on disk. The
 *      handle's `metadata.featureId` disambiguates the socket filename.
 *
 * A handle whose `socketPath` names a file that no longer exists is
 * treated as absent. Without this check the TUI would be handed a
 * dead path and surface "disconnected: connect ENOENT <path>" — the
 * regression captured in `resolve-chat-target-staleness.test.ts`.
 *
 * Returns `null` when no reachable agent is bound (e.g. autopilot is
 * paused, the task has terminated, or a runner crashed before its
 * socket was ever bound).
 */

import { access } from 'node:fs/promises';
import { findLiveTaskHandle, TaskRole } from '@noetic/code-agent/tasks';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { runnerSocketPath } from '@noetic/code-agent/tasks/store/fs-node';
import type { SubprocessHandle } from '@noetic/core';
import { PlannerSpawnError, PlannerSpawnErrorCode, startPlannerRun } from './planner-launcher.js';

//#region Types

export interface ChatTarget {
  readonly socketPath: string;
  readonly role: 'planner' | 'implementer';
  readonly roleLabel: string;
}

/** Probe for whether a unix-domain-socket file is reachable on disk. */
export type SocketReachabilityProbe = (socketPath: string) => Promise<boolean>;

export interface ResolveChatTargetOptions {
  /**
   * Subprocess adapter used to enumerate live runner handles by task id
   * and role. Required — callers thread the host-wide adapter through.
   */
  readonly subprocess: import('@noetic/core').SubprocessAdapter;
  /**
   * Probe the runner socket before accepting it as a target. Default
   * is a real `fs.access()` check. Tests pass stubs to simulate the
   * crashed-runner case without managing real unix-domain sockets.
   */
  readonly isSocketReachable?: SocketReachabilityProbe;
}

export interface WaitForChatTargetOptions extends ResolveChatTargetOptions {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
}

export interface EnsureChatTargetOptions extends ResolveChatTargetOptions {
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

//#region Helpers

const defaultIsSocketReachable: SocketReachabilityProbe = async (socketPath) => {
  try {
    await access(socketPath);
    return true;
  } catch {
    return false;
  }
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readMetadataString(handle: SubprocessHandle, key: string): string | null {
  const metadata = handle.metadata;
  if (!isRecord(metadata)) {
    return null;
  }
  const value = metadata[key];
  return typeof value === 'string' ? value : null;
}

//#endregion

//#region Public API

export async function resolveChatTarget(
  ctx: TaskStoreContext,
  taskId: string,
  opts: ResolveChatTargetOptions,
): Promise<ChatTarget | null> {
  const isReachable = opts.isSocketReachable ?? defaultIsSocketReachable;

  const plannerHandle = await findLiveTaskHandle({
    adapter: opts.subprocess,
    taskId,
    taskRole: TaskRole.Planner,
  });
  if (plannerHandle !== null) {
    // The planner is a singleton per task — its socket filename is
    // deterministic, so we reconstruct the path rather than storing it
    // on the handle. Matches the old sidecar-based resolution semantics.
    const socketPath = runnerSocketPath(ctx, {
      taskId,
      role: 'planner',
    });
    if (await isReachable(socketPath)) {
      return {
        socketPath,
        role: 'planner',
        roleLabel: 'planner',
      };
    }
  }

  const implementerHandle = await findLiveTaskHandle({
    adapter: opts.subprocess,
    taskId,
    taskRole: TaskRole.Implementer,
  });
  if (implementerHandle !== null) {
    const featureId = readMetadataString(implementerHandle, 'featureId');
    if (featureId !== null) {
      const socketPath = runnerSocketPath(ctx, {
        taskId,
        role: 'implementer',
        runnerId: featureId,
      });
      if (await isReachable(socketPath)) {
        return {
          socketPath,
          role: 'implementer',
          roleLabel: `implementer · ${featureId}`,
        };
      }
    }
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
    const target = await resolveChatTarget(ctx, taskId, {
      subprocess: opts.subprocess,
      isSocketReachable: opts.isSocketReachable,
    });
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
  opts: EnsureChatTargetOptions,
): Promise<ChatTarget | null> {
  const initial = await resolveChatTarget(ctx, taskId, {
    subprocess: opts.subprocess,
    isSocketReachable: opts.isSocketReachable,
  });
  if (initial !== null) {
    return initial;
  }
  opts.onSpawning?.();
  const start = opts.startPlannerRunFn ?? startPlannerRun;
  try {
    await start({
      ctx,
      taskId,
      subprocess: opts.subprocess,
    });
  } catch (err) {
    // `already-attached` means a planner is in flight (handle present,
    // pid alive) but hasn't bound the socket yet — fall through to poll.
    const alreadyAttached =
      err instanceof PlannerSpawnError && err.code === PlannerSpawnErrorCode.AlreadyAttached;
    if (!alreadyAttached) {
      return null;
    }
  }
  return waitForChatTarget(ctx, taskId, {
    subprocess: opts.subprocess,
    timeoutMs: opts.timeoutMs ?? 15e3,
    pollIntervalMs: opts.pollIntervalMs ?? 250,
    isSocketReachable: opts.isSocketReachable,
  });
}

//#endregion
