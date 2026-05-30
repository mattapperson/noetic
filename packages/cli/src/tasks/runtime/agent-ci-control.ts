/**
 * Pause / resume / cancel surfaces for the agent-ci runner. Reads the
 * sidecar `<taskDir>/_runner.json` written by the launcher, verifies the
 * pid is alive (and that the kernel-reported `lstart` matches the value
 * captured at spawn — defends against pid reuse), then sends the
 * appropriate POSIX signal to the runner's process group.
 *
 * Public surface:
 *  - `Signaller` — pluggable kill/probe interface (test seam).
 *  - `defaultSignaller` — `process.kill` + `ps -o lstart=` implementation.
 *  - `findActiveAgentCiRunner` — non-mutating lookup; replaces the legacy
 *    `findActiveAgentCiSession` query.
 *  - `cancelAgentCiRun` — SIGTERM the group, mark the task lifecycle
 *    appropriately, and clear the sidecar.
 *  - `togglePauseAgentCiRun` — SIGSTOP / SIGCONT, persisting `pausedAt`
 *    on the sidecar (NOT on `task.json` so volatile state never leaks
 *    into the canonical record).
 */

import { execFileSync } from 'node:child_process';
import type { Task } from '@noetic-tools/code-agent/tasks/schema';
import { EventKind, LogEntryKind, TaskReviewStatus } from '@noetic-tools/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic-tools/code-agent/tasks/store/fs-node';
import { appendEvent, appendLog, loadTask, saveTask } from '@noetic-tools/code-agent/tasks/store/fs-node';
import type { RunnerState } from './runner-state.js';
import { clearRunner, loadRunner, saveRunner } from './runner-state.js';

//#region Types

export type ControlSignal = 'SIGTERM' | 'SIGSTOP' | 'SIGCONT';

/** Pluggable signal interface; tests inject a recording mock. */
export interface Signaller {
  /**
   * Caller passes the negative process-group id (with detached spawn,
   * pgid === pid) to signal the whole tree. Pass a positive pid only for
   * direct control.
   */
  kill(target: number, signal: ControlSignal): void;
  isAlive(pid: number): boolean;
  startTime(pid: number): string | null;
}

export type AgentCiActionResult =
  | {
      kind: 'cancelled';
      sessionId: string;
      pid: number;
    }
  | {
      kind: 'paused';
      sessionId: string;
      pid: number;
    }
  | {
      kind: 'resumed';
      sessionId: string;
      pid: number;
    }
  | {
      kind: 'no_active_run';
      taskId: string;
    }
  | {
      kind: 'stale_process';
      sessionId: string;
      pid: number;
    };

interface ResolvedRunner {
  readonly runner: RunnerState;
  readonly pid: number;
  readonly groupTarget: number;
  readonly now: string;
}

type ResolveOutcome =
  | {
      kind: 'ready';
      ready: ResolvedRunner;
    }
  | {
      kind: 'rejected';
      result: AgentCiActionResult;
    };

//#endregion

//#region Default Signaller

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  if (!('code' in err)) {
    return false;
  }
  return typeof err.code === 'string';
}

function readPidStartTime(pid: number): string | null {
  try {
    const out = execFileSync(
      'ps',
      [
        '-p',
        String(pid),
        '-o',
        'lstart=',
      ],
      {
        stdio: [
          'ignore',
          'pipe',
          'ignore',
        ],
        encoding: 'utf8',
      },
    ).trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}

export const defaultSignaller: Signaller = {
  kill(target: number, signal: ControlSignal): void {
    process.kill(target, signal);
  },
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'EPERM') {
        return true;
      }
      return false;
    }
  },
  startTime(pid: number): string | null {
    return readPidStartTime(pid);
  },
};

//#endregion

//#region Queries

/**
 * Loads the runner sidecar for `taskId`, returning `null` when no
 * runner is recorded. Does not verify pid liveness — callers wanting
 * "is the runner actually alive" should follow up with
 * `signaller.isAlive(runner.pid)`.
 */
export async function findActiveAgentCiRunner(
  ctx: TaskStoreContext,
  taskId: string,
): Promise<RunnerState | null> {
  return loadRunner(ctx, taskId);
}

//#endregion

//#region Signal Helpers

interface KillOutcome {
  ok: boolean;
  alreadyDead: boolean;
}

function tryKill(signaller: Signaller, target: number, signal: ControlSignal): KillOutcome {
  try {
    signaller.kill(target, signal);
    return {
      ok: true,
      alreadyDead: false,
    };
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ESRCH') {
      return {
        ok: false,
        alreadyDead: true,
      };
    }
    throw err;
  }
}

//#endregion

//#region Resolution

const POSIX_AVAILABLE = process.platform !== 'win32';

interface ResolveArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly signaller: Signaller;
}

async function resolveActiveRunner(args: ResolveArgs): Promise<ResolveOutcome> {
  if (!POSIX_AVAILABLE) {
    return {
      kind: 'rejected',
      result: {
        kind: 'no_active_run',
        taskId: args.taskId,
      },
    };
  }
  const runner = await loadRunner(args.ctx, args.taskId);
  if (runner === null) {
    return {
      kind: 'rejected',
      result: {
        kind: 'no_active_run',
        taskId: args.taskId,
      },
    };
  }
  const now = new Date().toISOString();
  if (!verifyPidIdentity(args.signaller, runner.pid, runner.pidStarttime)) {
    await markRunnerStale({
      ctx: args.ctx,
      taskId: args.taskId,
      runner,
      now,
    });
    return {
      kind: 'rejected',
      result: {
        kind: 'stale_process',
        sessionId: runner.sessionId,
        pid: runner.pid,
      },
    };
  }
  return {
    kind: 'ready',
    ready: {
      runner,
      pid: runner.pid,
      groupTarget: -runner.pid,
      now,
    },
  };
}

/**
 * True when a stored pid is provably the same process we recorded:
 * pid is alive AND its current `startTime` matches the snapshot we
 * captured. Returns false on any uncertainty (dead pid, recycled pid,
 * `ps` failed for a live pid). A null `storedStartTime` falls back to
 * bare liveness — used when the platform couldn't snapshot startTime
 * at spawn time.
 */
export function verifyPidIdentity(
  signaller: Signaller,
  pid: number,
  storedStartTime: string | null,
): boolean {
  if (!signaller.isAlive(pid)) {
    return false;
  }
  if (storedStartTime === null) {
    return true;
  }
  const current = signaller.startTime(pid);
  if (current === null) {
    return false;
  }
  return current === storedStartTime;
}

//#endregion

//#region State helpers

interface MarkRunnerStaleArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly runner: RunnerState;
  readonly now: string;
}

/**
 * The recorded pid is dead or has been recycled. Drop the sidecar and
 * bounce the task into `needs_changes` so the operator knows the run
 * never completed cleanly.
 */
async function markRunnerStale(args: MarkRunnerStaleArgs): Promise<void> {
  await clearRunner(args.ctx, args.taskId);
  await appendLog(args.ctx, {
    taskId: args.taskId,
    entry: {
      kind: LogEntryKind.System,
      ts: args.now,
      message: `agent-ci runner pid=${args.runner.pid} no longer alive — clearing stale sidecar`,
    },
  });
  const task = await loadTask(args.ctx, args.taskId);
  // Leave terminal statuses (approved) alone; bounce reviewing → needs_changes.
  if (task.reviewStatus !== TaskReviewStatus.Reviewing) {
    return;
  }
  const next: Task = {
    ...task,
    reviewStatus: TaskReviewStatus.NeedsChanges,
    paused: false,
    pauseReason: null,
    updatedAt: args.now,
    lastSeenAt: args.now,
  };
  await saveTask(args.ctx, next);
  await appendEvent(args.ctx, {
    taskId: args.taskId,
    kind: EventKind.TaskReviewStatusChanged,
    payload: {
      previousReviewStatus: TaskReviewStatus.Reviewing,
      reviewStatus: TaskReviewStatus.NeedsChanges,
      reason: 'stale_runner',
      pid: args.runner.pid,
    },
    ts: args.now,
  });
}

interface AppendCancelLogArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly runner: RunnerState;
  readonly now: string;
}

async function appendCancelLog(args: AppendCancelLogArgs): Promise<void> {
  await appendLog(args.ctx, {
    taskId: args.taskId,
    entry: {
      kind: LogEntryKind.System,
      ts: args.now,
      message: `agent-ci runner pid=${args.runner.pid} cancelled (SIGTERM sent to process group)`,
    },
  });
}

//#endregion

//#region Public API

/**
 * Send SIGTERM to the runner's process group. Resumes a paused runner
 * first so SIGTERM lands. The sidecar is cleared on success so the next
 * launch starts from a clean slate.
 */
export async function cancelAgentCiRun(
  ctx: TaskStoreContext,
  taskId: string,
  signaller: Signaller = defaultSignaller,
): Promise<AgentCiActionResult> {
  const outcome = await resolveActiveRunner({
    ctx,
    taskId,
    signaller,
  });
  if (outcome.kind === 'rejected') {
    return outcome.result;
  }
  const { runner, pid, groupTarget, now } = outcome.ready;
  if (runner.pausedAt !== null) {
    tryKill(signaller, groupTarget, 'SIGCONT');
  }
  const term = tryKill(signaller, groupTarget, 'SIGTERM');
  await appendCancelLog({
    ctx,
    taskId,
    runner,
    now,
  });
  await clearRunner(ctx, taskId);
  if (term.alreadyDead) {
    return {
      kind: 'stale_process',
      sessionId: runner.sessionId,
      pid,
    };
  }
  return {
    kind: 'cancelled',
    sessionId: runner.sessionId,
    pid,
  };
}

/**
 * Toggle SIGSTOP / SIGCONT on the runner's process group. Records
 * `pausedAt` in the sidecar before sending SIGSTOP (so a signal failure
 * leaves the sidecar in a consistent state); clears `pausedAt` before
 * sending SIGCONT for the same reason. Both branches roll back on signal
 * failure.
 */
export async function togglePauseAgentCiRun(
  ctx: TaskStoreContext,
  taskId: string,
  signaller: Signaller = defaultSignaller,
): Promise<AgentCiActionResult> {
  const outcome = await resolveActiveRunner({
    ctx,
    taskId,
    signaller,
  });
  if (outcome.kind === 'rejected') {
    return outcome.result;
  }
  const { runner, pid, groupTarget, now } = outcome.ready;
  if (runner.pausedAt === null) {
    return doPause({
      ctx,
      runner,
      pid,
      groupTarget,
      now,
      signaller,
    });
  }
  return doResume({
    ctx,
    runner,
    pid,
    groupTarget,
    now,
    signaller,
  });
}

interface ToggleArgs {
  readonly ctx: TaskStoreContext;
  readonly runner: RunnerState;
  readonly pid: number;
  readonly groupTarget: number;
  readonly now: string;
  readonly signaller: Signaller;
}

async function persistPausedAt(
  ctx: TaskStoreContext,
  runner: RunnerState,
  pausedAt: string | null,
): Promise<RunnerState> {
  const next: RunnerState = {
    ...runner,
    pausedAt,
  };
  await saveRunner(ctx, next);
  return next;
}

async function doPause(args: ToggleArgs): Promise<AgentCiActionResult> {
  // Persist sidecar first so a failed signal is rolled back; never leave
  // a stopped child without a record of why.
  await persistPausedAt(args.ctx, args.runner, args.now);
  try {
    args.signaller.kill(args.groupTarget, 'SIGSTOP');
  } catch (err) {
    await persistPausedAt(args.ctx, args.runner, null);
    throw err;
  }
  return {
    kind: 'paused',
    sessionId: args.runner.sessionId,
    pid: args.pid,
  };
}

async function doResume(args: ToggleArgs): Promise<AgentCiActionResult> {
  const previousPausedAt = args.runner.pausedAt;
  await persistPausedAt(args.ctx, args.runner, null);
  try {
    args.signaller.kill(args.groupTarget, 'SIGCONT');
  } catch (err) {
    await persistPausedAt(args.ctx, args.runner, previousPausedAt);
    throw err;
  }
  return {
    kind: 'resumed',
    sessionId: args.runner.sessionId,
    pid: args.pid,
  };
}

//#endregion
