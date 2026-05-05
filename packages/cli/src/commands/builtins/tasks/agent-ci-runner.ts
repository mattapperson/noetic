/**
 * Wrapper script that owns the agent-ci subprocess lifecycle for a single
 * task review. Spawned by the launcher via `bun run`. Reads
 * `NOETIC_TASK_DIR` from the env, derives task identity, spawns
 * `npx @redwoodjs/agent-ci run --workflow <wf>` (inheriting stdio so the
 * user sees the output), waits for exit, then commits three writes in
 * order — log → task.json → _events.jsonl — so a tailer never observes a
 * post-state event without the corresponding state mutation.
 *
 * Order rationale (audit → state → event):
 *   1. Append a system log entry first. The audit trail is the most
 *      conservative; it never lies about "we tried to run agent-ci" even
 *      if the canonical state write later fails.
 *   2. Atomically rewrite `task.json` to flip `reviewStatus`. Readers
 *      across processes see the new state at the rename boundary.
 *   3. Append the event last. Readers tailing `_events.jsonl` use the
 *      event's `taskId` to re-load `task.json` and will always see the
 *      already-published state.
 */

import type { ChildProcess, SpawnOptions, StdioOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { basename, dirname } from 'node:path';

import { createLocalFsAdapter } from '@noetic/core';

import type { TaskStoreContext } from './fs-store.js';
import { appendEvent, appendLog, loadTask, saveTask } from './fs-store.js';
import { clearRunner, loadRunner } from './runner-state.js';
import type { Task } from './schemas.js';
import { EventKind, LogEntryKind, TaskReviewStatus } from './schemas.js';

//#region Types

type RunnerSpawnedChild = Pick<ChildProcess, 'pid'> & {
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
};

export type RunnerSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => RunnerSpawnedChild;

export interface RunAgentCiOptions {
  /** Task store context. Defaulted from env / FS when run as a script. */
  ctx?: TaskStoreContext;
  /** Spawn function, mockable in tests. */
  spawnFn?: RunnerSpawn;
  /** Override `NOETIC_TASK_DIR` for tests; defaults to env. */
  taskDir?: string;
  /** Override the workflow path for tests; defaults to `NOETIC_TASK_WORKFLOW`. */
  workflow?: string;
  /** Override the cwd handed to the child; defaults to `NOETIC_TASK_CWD`. */
  cwd?: string;
}

export interface RunAgentCiResult {
  taskId: string;
  exitCode: number;
  previousReviewStatus: TaskReviewStatus;
  reviewStatus: TaskReviewStatus;
}

//#endregion

//#region Helpers

const ENV_TASK_DIR = 'NOETIC_TASK_DIR';
const ENV_WORKFLOW = 'NOETIC_TASK_WORKFLOW';
const ENV_CWD = 'NOETIC_TASK_CWD';

const defaultSpawn: RunnerSpawn = (command, args, options) => spawn(command, args.slice(), options);

function readEnv(name: string): string | null {
  const v = process.env[name];
  if (v === undefined || v.length === 0) {
    return null;
  }
  return v;
}

/**
 * `<tasksRoot>/T-<id>` → tasksRoot. Task state lives directly under
 * the user-global tasks-root (`~/.noetic/tasks` by default).
 */
function tasksRootFromTaskDir(taskDir: string): string {
  return dirname(taskDir);
}

function taskIdFromTaskDir(taskDir: string): string {
  return basename(taskDir);
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Map an exit code to the terminal review status. Zero ⇒ approved
 * (review passed, ready to merge). Non-zero ⇒ needs_changes.
 */
function reviewStatusFromExit(exitCode: number): TaskReviewStatus {
  if (exitCode === 0) {
    return TaskReviewStatus.Approved;
  }
  return TaskReviewStatus.NeedsChanges;
}

interface SpawnArgs {
  spawnFn: RunnerSpawn;
  workflow: string;
  cwd: string;
}

/**
 * Spawn agent-ci and resolve with its exit code. Stdio is inherited so
 * the user sees the same output they would get running agent-ci by hand.
 */
function spawnAgentCi(args: SpawnArgs): Promise<number> {
  const stdio: StdioOptions = 'inherit';
  return new Promise((resolve, reject) => {
    const child = args.spawnFn(
      'npx',
      [
        '@redwoodjs/agent-ci',
        'run',
        '--workflow',
        args.workflow,
      ],
      {
        cwd: args.cwd,
        stdio,
      },
    );
    child.on('error', (err) => {
      reject(err);
    });
    child.on('exit', (code, _signal) => {
      // null code ⇒ killed by signal; treat as failure (1) for the runner.
      resolve(code ?? 1);
    });
  });
}

interface CommitWritesArgs {
  ctx: TaskStoreContext;
  taskId: string;
  exitCode: number;
}

interface CommitWritesResult {
  previousReviewStatus: TaskReviewStatus;
  reviewStatus: TaskReviewStatus;
}

/**
 * Commits the three on-exit writes in order: audit (log) → state (task.json)
 * → event (_events.jsonl). Each write is independently recoverable;
 * failures bubble up and the caller decides whether to exit non-zero.
 * Out-of-process consumers tail `_events.jsonl` (or subscribe through the
 * external `tasks.events` channel) for a durable, replayable feed.
 */
async function commitExitWrites(args: CommitWritesArgs): Promise<CommitWritesResult> {
  const ts = nowIso();

  // 1) Audit: log entry first.
  await appendLog(args.ctx, {
    taskId: args.taskId,
    entry: {
      kind: LogEntryKind.System,
      ts,
      message: `agent-ci exited with code ${args.exitCode}`,
    },
  });

  // 2) State: atomically rewrite task.json.
  const existing = await loadTask(args.ctx, args.taskId);
  const previousReviewStatus = existing.reviewStatus;
  const reviewStatus = reviewStatusFromExit(args.exitCode);
  const next: Task = {
    ...existing,
    reviewStatus,
    paused: false,
    pauseReason: null,
    updatedAt: ts,
    lastSeenAt: ts,
  };
  await saveTask(args.ctx, next);

  // 3) Event: append _events.jsonl. The append is the durable record;
  // tailers (TUI, daemon flow via the external `tasks.events` channel)
  // observe the row at the rename boundary.
  await appendEvent(args.ctx, {
    taskId: args.taskId,
    kind: EventKind.TaskReviewStatusChanged,
    payload: {
      previousReviewStatus,
      reviewStatus,
      exitCode: args.exitCode,
    },
    ts,
  });

  // Best-effort: the runner is dead; clear the runner-state file so the
  // next launch starts from a clean slate. Failure here is non-fatal — a
  // stale runner-state will be evicted by the launcher's own pid check.
  try {
    await clearRunner(args.ctx, args.taskId);
  } catch {
    /* swallow — see comment above */
  }

  return {
    previousReviewStatus,
    reviewStatus,
  };
}

//#endregion

//#region Public API

/**
 * Run a single agent-ci review under a task directory. Resolves once the
 * child has exited and all three on-exit writes have been committed. The
 * caller (or the script entry point) is responsible for translating
 * `result.exitCode` into a process exit.
 */
export async function runAgentCi(opts: RunAgentCiOptions = {}): Promise<RunAgentCiResult> {
  const taskDir = opts.taskDir ?? readEnv(ENV_TASK_DIR);
  if (taskDir === null) {
    throw new Error(`${ENV_TASK_DIR} env var is required to run agent-ci`);
  }
  const workflow = opts.workflow ?? readEnv(ENV_WORKFLOW);
  if (workflow === null) {
    throw new Error(`${ENV_WORKFLOW} env var is required to run agent-ci`);
  }
  const cwd = opts.cwd ?? readEnv(ENV_CWD) ?? process.cwd();

  const taskId = taskIdFromTaskDir(taskDir);
  const tasksRoot = tasksRootFromTaskDir(taskDir);
  const ctx = opts.ctx ?? {
    fs: createLocalFsAdapter(),
    projectRoot: cwd,
    tasksRoot,
  };
  const spawnFn = opts.spawnFn ?? defaultSpawn;

  // Best-effort: keep the in-memory runner record around until exit. The
  // launcher already wrote it; we just read it to surface a richer log
  // line on exit.
  const runner = await loadRunner(ctx, taskId);
  if (runner !== null) {
    await appendLog(ctx, {
      taskId,
      entry: {
        kind: LogEntryKind.System,
        ts: nowIso(),
        message: `agent-ci runner started (pid=${runner.pid}, workflow=${workflow})`,
      },
    });
  }

  const exitCode = await spawnAgentCi({
    spawnFn,
    workflow,
    cwd,
  });

  const { previousReviewStatus, reviewStatus } = await commitExitWrites({
    ctx,
    taskId,
    exitCode,
  });

  return {
    taskId,
    exitCode,
    previousReviewStatus,
    reviewStatus,
  };
}

//#endregion

//#region Script entry point

if (import.meta.main) {
  runAgentCi()
    .then((result) => {
      process.exit(result.exitCode);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`agent-ci-runner: ${msg}\n`);
      process.exit(1);
    });
}

//#endregion
