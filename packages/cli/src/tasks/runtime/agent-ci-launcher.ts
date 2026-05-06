/**
 * Spawns the `agent-ci-runner.ts` wrapper as a detached `bun run` child
 * for a given task. Persists the runner's pid + identity tuple to
 * `<taskDir>/_runner.json` (sidecar so volatile state never touches the
 * canonical `task.json`), atomically flips `task.json#reviewStatus` to
 * `reviewing` for non-terminal tasks, and emits a
 * `task:reviewStatusChanged` event on both the durable feed and the
 * in-process bus.
 *
 * Spawn order (idempotent contract):
 *  1. Refuse if a live runner is already attached (stale entries are
 *     evicted in step 1 — verified pid + matching `pidStarttime`).
 *  2. Spawn the wrapper with `NOETIC_TASK_*` env so the child can locate
 *     its task directory without sharing in-memory state with the parent.
 *  3. Verify the kernel reports a live pid and capture
 *     `Signaller.startTime` so the control surfaces can detect pid
 *     reuse.
 *  4. Persist `_runner.json` atomically.
 *  5. Patch `task.json#reviewStatus`.
 *  6. Append the `task:reviewStatusChanged` event (durable + in-process).
 *
 * If a step after the spawn fails we attempt to tear down the child and
 * remove the runner sidecar before bubbling the error so we never leave
 * an orphaned process tracked by a half-written runner record.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';

import { fileUrlToPath, randomHex } from '@noetic/code-agent/tasks';
import { basename, resolve } from '@noetic/code-agent/tasks/path-utils';
import type { Task } from '@noetic/code-agent/tasks/schema';
import { EventKind, TaskReviewStatus } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import {
  appendEvent,
  loadTask,
  saveTask,
  taskDirPaths,
} from '@noetic/code-agent/tasks/store/fs-node';
import type { Signaller } from './agent-ci-control.js';
import { defaultSignaller } from './agent-ci-control.js';
import { clearRunner, loadRunner, saveRunner } from './runner-state.js';

//#region Types

type SpawnedChild = Pick<ChildProcess, 'pid' | 'unref'> & {
  on(event: 'error', listener: (err: Error) => void): unknown;
};

/** Pluggable spawn function — primarily a test seam. */
export type AgentCiSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => SpawnedChild;

/** Argument bag for {@link startAgentCiRun}. */
export interface StartAgentCiRunArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly workflow: string;
  readonly cwd: string;
  /** Test seam: override the default `bun run` spawn. */
  readonly spawnFn?: AgentCiSpawn;
  readonly signaller?: Signaller;
  readonly now?: string;
  /**
   * Path to the `agent-ci-runner.ts` script. Resolved from the launcher
   * file's location by default; tests override to avoid relying on
   * `import.meta.url`.
   */
  readonly runnerScript?: string;
  /** Extra environment passed through to the runner child. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Result of a successful spawn. */
export interface StartAgentCiRunResult {
  readonly sessionId: string;
  readonly pid: number;
  readonly workflow: string;
  readonly taskId: string;
  readonly previousReviewStatus: TaskReviewStatus;
  readonly reviewStatus: TaskReviewStatus;
}

/** Thrown when the runner child fails to start or a pre-spawn check rejects. */
export class AgentCiSpawnError extends Error {
  constructor(message: string, cause: unknown = null) {
    super(message, {
      cause,
    });
    this.name = 'AgentCiSpawnError';
  }
}

//#endregion

//#region Defaults

const defaultSpawn: AgentCiSpawn = (command, args, options) =>
  spawn(command, args.slice(), options);

const TERMINAL_REVIEW_STATUSES: ReadonlySet<TaskReviewStatus> = new Set([
  TaskReviewStatus.Approved,
]);

function defaultRunnerScript(): string {
  // The runner ships beside the launcher in `dist/...`; tests inject a path.
  return fileUrlToPath(new URL('agent-ci-runner.ts', import.meta.url));
}

function makeSessionId(taskId: string): string {
  return `${taskId}-${randomHex(4)}`;
}

//#endregion

//#region Helpers

interface SpawnRunnerArgs {
  readonly spawnFn: AgentCiSpawn;
  readonly runnerScript: string;
  readonly cwd: string;
  readonly taskDir: string;
  readonly workflow: string;
  readonly extraEnv: NodeJS.ProcessEnv | undefined;
  readonly signaller: Signaller;
}

interface SpawnRunnerOk {
  readonly kind: 'ok';
  readonly pid: number;
  readonly pidStarttime: string | null;
}

interface SpawnRunnerError {
  readonly kind: 'error';
  readonly error: AgentCiSpawnError;
}

type SpawnRunnerResult = SpawnRunnerOk | SpawnRunnerError;

function buildRunnerEnv(args: SpawnRunnerArgs): NodeJS.ProcessEnv {
  const base = args.extraEnv ?? process.env;
  return {
    ...base,
    NOETIC_TASK_DIR: args.taskDir,
    NOETIC_TASK_WORKFLOW: args.workflow,
    NOETIC_TASK_CWD: args.cwd,
  };
}

function spawnRunner(args: SpawnRunnerArgs): SpawnRunnerResult {
  const child = args.spawnFn(
    'bun',
    [
      'run',
      args.runnerScript,
    ],
    {
      cwd: args.cwd,
      detached: true,
      stdio: 'ignore',
      env: buildRunnerEnv(args),
    },
  );
  let asyncSpawnError: unknown = null;
  child.on('error', (err: unknown) => {
    asyncSpawnError = err;
  });
  child.unref();

  if (child.pid === undefined) {
    return {
      kind: 'error',
      error: new AgentCiSpawnError(
        'agent-ci runner failed to start: no pid returned by spawn',
        asyncSpawnError,
      ),
    };
  }
  const pid = child.pid;
  if (!args.signaller.isAlive(pid)) {
    return {
      kind: 'error',
      error: new AgentCiSpawnError(
        `agent-ci runner pid=${pid} did not start (likely missing bun or invalid script)`,
        asyncSpawnError,
      ),
    };
  }
  return {
    kind: 'ok',
    pid,
    pidStarttime: args.signaller.startTime(pid),
  };
}

interface IsLiveRunnerArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly signaller: Signaller;
}

/**
 * True when `<taskDir>/_runner.json` exists, the recorded pid is alive,
 * and (when we have a recorded `pidStarttime`) the kernel's current
 * `startTime` for that pid still matches. Stale records — pid recycled,
 * pid dead — return false so the launcher can overwrite them.
 */
async function isLiveRunner(args: IsLiveRunnerArgs): Promise<boolean> {
  const existing = await loadRunner(args.ctx, args.taskId);
  if (existing === null) {
    return false;
  }
  if (!args.signaller.isAlive(existing.pid)) {
    return false;
  }
  if (existing.pidStarttime === null) {
    return true;
  }
  const current = args.signaller.startTime(existing.pid);
  if (current === null) {
    return false;
  }
  return current === existing.pidStarttime;
}

interface PatchTaskArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly now: string;
}

interface PatchTaskResult {
  readonly previousReviewStatus: TaskReviewStatus;
  readonly reviewStatus: TaskReviewStatus;
}

/**
 * Move a non-terminal task to `reviewing` and refresh `lastSeenAt`.
 * Terminal tasks (already approved) keep their review status — the
 * launcher still spawns the runner so the next exit can transition.
 */
async function patchTaskForReview(args: PatchTaskArgs): Promise<PatchTaskResult> {
  const task = await loadTask(args.ctx, args.taskId);
  const previousReviewStatus = task.reviewStatus;
  const reviewStatus = TERMINAL_REVIEW_STATUSES.has(previousReviewStatus)
    ? previousReviewStatus
    : TaskReviewStatus.Reviewing;
  const next: Task = {
    ...task,
    reviewStatus,
    paused: false,
    pauseReason: null,
    updatedAt: args.now,
    lastSeenAt: args.now,
  };
  await saveTask(args.ctx, next);
  return {
    previousReviewStatus,
    reviewStatus,
  };
}

interface EmitReviewEventArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly previousReviewStatus: TaskReviewStatus;
  readonly reviewStatus: TaskReviewStatus;
  readonly sessionId: string;
  readonly pid: number;
  readonly workflow: string;
  readonly now: string;
}

async function emitReviewEvent(args: EmitReviewEventArgs): Promise<void> {
  await appendEvent(args.ctx, {
    taskId: args.taskId,
    kind: EventKind.TaskReviewStatusChanged,
    payload: {
      previousReviewStatus: args.previousReviewStatus,
      reviewStatus: args.reviewStatus,
      sessionId: args.sessionId,
      pid: args.pid,
      workflow: args.workflow,
      phase: 'spawn',
    },
    ts: args.now,
  });
}

interface AbortChildArgs {
  readonly signaller: Signaller;
  readonly pid: number;
}

/** Best-effort: kill the runner pid (group), swallowing missing-process. */
function abortChild(args: AbortChildArgs): void {
  try {
    args.signaller.kill(-args.pid, 'SIGTERM');
  } catch {
    /* swallow — child may already be gone */
  }
}

//#endregion

//#region Public API

/**
 * Spawn an agent-ci review runner for `taskId`. Throws
 * {@link AgentCiSpawnError} if the wrapper child fails to start or if
 * another live runner is already attached to this task.
 *
 * The caller is responsible for translating the resolved
 * `previousReviewStatus`/`reviewStatus` into UI feedback.
 */
export async function startAgentCiRun(args: StartAgentCiRunArgs): Promise<StartAgentCiRunResult> {
  const workflow = args.workflow.trim();
  if (workflow.length === 0) {
    throw new Error('workflow path is required');
  }
  const cwd = resolve(args.cwd);
  const spawnFn = args.spawnFn ?? defaultSpawn;
  const signaller = args.signaller ?? defaultSignaller;
  const now = args.now ?? new Date().toISOString();
  const runnerScript = args.runnerScript ?? defaultRunnerScript();

  const taskDir = taskDirPaths(args.ctx, args.taskId).dir;

  // 1. Reject re-spawn if a live runner is already attached.
  const live = await isLiveRunner({
    ctx: args.ctx,
    taskId: args.taskId,
    signaller,
  });
  if (live) {
    throw new AgentCiSpawnError(`agent-ci runner already attached to task ${args.taskId}`);
  }

  // 2. Spawn the wrapper.
  const spawned = spawnRunner({
    spawnFn,
    runnerScript,
    cwd,
    taskDir,
    workflow,
    extraEnv: args.env,
    signaller,
  });
  if (spawned.kind === 'error') {
    throw spawned.error;
  }

  const sessionId = makeSessionId(args.taskId);
  // 3. Persist the sidecar before flipping task state — readers that watch
  //    for `_runner.json` will see a live record corresponding to a live
  //    pid before any review-status event lands.
  try {
    await saveRunner(args.ctx, {
      taskId: args.taskId,
      sessionId,
      pid: spawned.pid,
      pidStarttime: spawned.pidStarttime,
      workflow,
      startedAt: now,
      pausedAt: null,
    });
  } catch (err) {
    abortChild({
      signaller,
      pid: spawned.pid,
    });
    throw err;
  }

  // 4. Patch task.json. On failure, roll back the sidecar so a half-state
  //    isn't observable.
  let patch: PatchTaskResult;
  try {
    patch = await patchTaskForReview({
      ctx: args.ctx,
      taskId: args.taskId,
      now,
    });
  } catch (err) {
    abortChild({
      signaller,
      pid: spawned.pid,
    });
    await clearRunner(args.ctx, args.taskId).catch(() => {
      /* swallow — best-effort cleanup */
    });
    throw err;
  }

  // 5. Emit the event last so consumers always see the persisted task
  //    state by the time they re-load the record.
  await emitReviewEvent({
    ctx: args.ctx,
    taskId: args.taskId,
    previousReviewStatus: patch.previousReviewStatus,
    reviewStatus: patch.reviewStatus,
    sessionId,
    pid: spawned.pid,
    workflow,
    now,
  });

  return {
    sessionId,
    pid: spawned.pid,
    workflow,
    taskId: args.taskId,
    previousReviewStatus: patch.previousReviewStatus,
    reviewStatus: patch.reviewStatus,
  };
}

/** Convenience: human-readable summary of a spawn result. */
export function summarizeStartResult(result: StartAgentCiRunResult): string {
  return `agent-ci runner spawned (taskId=${result.taskId}, pid=${result.pid}, session=${result.sessionId}, workflow=${basename(result.workflow)})`;
}

//#endregion
