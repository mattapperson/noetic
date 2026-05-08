/**
 * Task state transitions: move (kanban column), pause, unpause,
 * merge (worktree → trunk), attach (add file attachment).
 */

import { basename, format, join, parse } from '@noetic/code-agent/tasks/path-utils';
import type { LogEntry, Task } from '@noetic/code-agent/tasks/schema';
import { EventKind, LogEntryKind, TaskLifecycleStatus } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import {
  appendEvent,
  appendLog,
  isEnoent,
  saveTask,
  taskDirPaths,
} from '@noetic/code-agent/tasks/store/fs-node';
import { execTolerantOfMissing, isShellMissing } from '@noetic/code-agent/tasks/worktree-node';
import type { FsAdapter, ShellAdapter, ShellExecResult } from '@noetic/core';
import { createLocalFsAdapter, createLocalShellAdapter } from '@noetic/platform-node';
import type { AgentCiActionResult, Signaller } from '../agent-ci-control.js';
import { togglePauseAgentCiRun } from '../agent-ci-control.js';
import { deriveColumn, KanbanColumn, moveTask } from '../kanban.js';
import { nowIso, resolveTask } from './_shared.js';

//#region move

export interface MoveTaskHandlerArgs {
  readonly taskId: string;
  readonly column: KanbanColumn;
  /**
   * Override the reconciler-owned guard. Required to move a task
   * INTO `removed` or `cleanup_blocked` since those columns are
   * normally only reached by the daemon's reconcile pass.
   */
  readonly force?: boolean;
}

export interface MoveTaskHandlerResult {
  readonly task: Task;
  readonly previousColumn: KanbanColumn;
  readonly column: KanbanColumn;
}

/**
 * Columns that are typically owned by daemon-side state machines, not
 * direct user moves: `removed` (set by `reconcile-flow` when a worktree
 * disappears) and `cleanup_blocked` (set by the cleanup subsystem when
 * post-merge cleanup fails). Manual moves into these need `--force` to
 * avoid silent state oscillation when the next reconcile tick reverts
 * the user's change.
 */
const RECONCILER_OWNED_COLUMNS: ReadonlySet<KanbanColumn> = new Set([
  KanbanColumn.Removed,
  KanbanColumn.CleanupBlocked,
]);

/**
 * Move a task into a kanban column. Looks up the previous column from
 * the existing task record so the emitted event carries both endpoints
 * — useful for any UI tracking column-to-column transitions.
 *
 * Refuses to move a task INTO a reconciler-owned terminal column
 * (`removed`, `cleanup_blocked`) without an explicit `force: true`.
 * Moves OUT of those columns are always allowed (operator override).
 */
export async function moveTaskHandler(
  ctx: TaskStoreContext,
  args: MoveTaskHandlerArgs,
): Promise<MoveTaskHandlerResult> {
  const existing = await resolveTask(ctx, args.taskId);
  const previousColumn = deriveColumn(existing);
  if (RECONCILER_OWNED_COLUMNS.has(args.column) && args.force !== true) {
    throw new Error(
      `Refusing to move ${args.taskId} to '${args.column}': this column is reconciler-owned. Pass --force if you really mean it.`,
    );
  }
  const updated = await moveTask(ctx, {
    taskId: args.taskId,
    column: args.column,
  });
  await appendEvent(ctx, {
    taskId: updated.id,
    kind: EventKind.TaskMoved,
    payload: {
      previousColumn,
      column: args.column,
    },
    ts: nowIso(),
  });
  return {
    task: updated,
    previousColumn,
    column: args.column,
  };
}

//#endregion

//#region pause

export interface PauseTaskArgs {
  readonly taskId: string;
  /** Optional injection seam for tests. */
  readonly signaller?: Signaller;
}

export interface PauseTaskResult {
  readonly outcome: AgentCiActionResult;
}

/**
 * Pause the active agent-ci runner for a task. Idempotent against an
 * already-paused runner (the underlying control surface toggles, so a
 * caller wanting strict pause-only semantics should inspect
 * `outcome.kind` and call `unpauseTaskHandler` if `resumed`).
 */
export async function pauseTaskHandler(
  ctx: TaskStoreContext,
  args: PauseTaskArgs,
): Promise<PauseTaskResult> {
  await resolveTask(ctx, args.taskId);
  const outcome = await togglePauseAgentCiRun(ctx, args.taskId, args.signaller);
  return {
    outcome,
  };
}

//#endregion

//#region unpause

export interface UnpauseTaskArgs {
  readonly taskId: string;
  /** Optional injection seam for tests. */
  readonly signaller?: Signaller;
}

export interface UnpauseTaskResult {
  readonly outcome: AgentCiActionResult;
}

/**
 * Resume a paused agent-ci runner. Wraps the underlying toggle so the
 * verb name reads naturally on the CLI; semantically a pause/unpause
 * pair is just two calls to `togglePauseAgentCiRun`.
 */
export async function unpauseTaskHandler(
  ctx: TaskStoreContext,
  args: UnpauseTaskArgs,
): Promise<UnpauseTaskResult> {
  await resolveTask(ctx, args.taskId);
  const outcome = await togglePauseAgentCiRun(ctx, args.taskId, args.signaller);
  return {
    outcome,
  };
}

//#endregion

//#region merge

export interface MergeTaskArgs {
  readonly taskId: string;
  /**
   * Optional override for the branch to merge. Defaults to the
   * `branch` recorded on the task (typically populated by the
   * worktree reconciler).
   */
  readonly branch?: string;
  /** Working directory for `wt`/`git`. Defaults to the project root. */
  readonly cwd?: string;
  /** Injection seam for tests. */
  readonly shell?: ShellAdapter;
}

export interface MergeTaskResult {
  readonly task: Task;
  readonly tool: 'wt' | 'git';
  readonly stdout: string;
  readonly stderr: string;
}

async function tryWtMerge(args: { shell: ShellAdapter; branch: string; cwd: string }): Promise<{
  ok: boolean;
  result: ShellExecResult;
}> {
  const result = await execTolerantOfMissing(args.shell, `wt merge ${args.branch}`, args.cwd);
  if (isShellMissing(result)) {
    return {
      ok: false,
      result,
    };
  }
  // wt is on PATH — surface its outcome (success or genuine failure) as ok.
  return {
    ok: true,
    result,
  };
}

/**
 * Merge the task's branch via `wt merge` (worktrunk) when available;
 * fall back to `git merge` if `wt` is not on PATH. On a successful
 * merge the task lifecycle flips to `merged` and a
 * `task:reviewStatusChanged` event records the outcome.
 */
export async function mergeTaskHandler(
  ctx: TaskStoreContext,
  args: MergeTaskArgs,
): Promise<MergeTaskResult> {
  const existing = await resolveTask(ctx, args.taskId);
  const branch = args.branch ?? existing.branch;
  if (branch === null || branch.length === 0) {
    throw new Error(`Cannot merge task ${existing.id}: no branch is recorded`);
  }
  const cwd = args.cwd ?? existing.projectRoot;
  const shell = args.shell ?? createLocalShellAdapter();

  const wtAttempt = await tryWtMerge({
    shell,
    branch,
    cwd,
  });
  let tool: 'wt' | 'git';
  let result: ShellExecResult;
  if (wtAttempt.ok) {
    tool = 'wt';
    result = wtAttempt.result;
  } else {
    tool = 'git';
    result = await shell.exec(`git merge --no-edit ${branch}`, {
      cwd,
    });
  }

  if (result.exitCode !== 0) {
    throw new Error(
      `Merge via ${tool} failed for ${branch} (exit ${result.exitCode ?? 'null'}): ${
        result.stderr || result.stdout
      }`,
    );
  }

  const ts = nowIso();
  const previousReviewStatus = existing.reviewStatus;
  const next: Task = {
    ...existing,
    lifecycleStatus: TaskLifecycleStatus.Merged,
    updatedAt: ts,
  };
  await saveTask(ctx, next);
  await appendEvent(ctx, {
    taskId: next.id,
    kind: EventKind.TaskReviewStatusChanged,
    payload: {
      previousReviewStatus,
      reviewStatus: next.reviewStatus,
      mergedVia: tool,
      branch,
    },
    ts,
  });
  return {
    task: next,
    tool,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

//#endregion

//#region attach

const MAX_RENAME_TRIES = 1_000;

export interface AttachTaskArgs {
  readonly taskId: string;
  /** Absolute path to the file the user wants to attach. */
  readonly sourcePath: string;
  /**
   * Optional `FsAdapter` for reading the source file. Defaults to a
   * fresh local adapter so the handler stays self-sufficient outside
   * tests.
   */
  readonly sourceFs?: FsAdapter;
}

export interface AttachTaskResult {
  readonly attachmentPath: string;
  readonly entry: LogEntry;
}

async function pathExists(ctx: TaskStoreContext, p: string): Promise<boolean> {
  try {
    await ctx.fs.access(p);
    return true;
  } catch (err) {
    if (isEnoent(err)) {
      return false;
    }
    throw err;
  }
}

/**
 * Pick a destination filename inside `dir` that doesn't already exist.
 * Appends ` (N)` before the extension on conflict (e.g. `foo.png` →
 * `foo (1).png` → `foo (2).png` → ...). Caps tries at `MAX_RENAME_TRIES`
 * to bound the search.
 */
async function uniqueDestinationPath(
  ctx: TaskStoreContext,
  dir: string,
  fileName: string,
): Promise<string> {
  const candidate = join(dir, fileName);
  if (!(await pathExists(ctx, candidate))) {
    return candidate;
  }
  const parsed = parse(fileName);
  for (let n = 1; n <= MAX_RENAME_TRIES; n++) {
    const next = format({
      dir,
      name: `${parsed.name} (${n})`,
      ext: parsed.ext,
    });
    if (!(await pathExists(ctx, next))) {
      return next;
    }
  }
  throw new Error(
    `Refusing to attach ${fileName}: ${MAX_RENAME_TRIES} conflict candidates already exist in ${dir}`,
  );
}

/**
 * Copy `sourcePath` into `<taskDir>/attachments/<basename>` and record
 * the attachment in the task's log. Writes via `writeFileBytes` so
 * binary attachments (images, PDFs, etc.) round-trip byte-identically.
 * On a basename collision in the destination dir, the new file is
 * suffixed with ` (N)` before the extension instead of overwriting.
 */
export async function attachTaskHandler(
  ctx: TaskStoreContext,
  args: AttachTaskArgs,
): Promise<AttachTaskResult> {
  await resolveTask(ctx, args.taskId);
  const sourceFs = args.sourceFs ?? createLocalFsAdapter();
  const fileName = basename(args.sourcePath);
  if (fileName.length === 0) {
    throw new Error(`Cannot derive a file name from source path ${args.sourcePath}`);
  }
  const paths = taskDirPaths(ctx, args.taskId);
  await ctx.fs.mkdir(paths.attachments);
  const destination = await uniqueDestinationPath(ctx, paths.attachments, fileName);
  const contents = await sourceFs.readFile(args.sourcePath);
  await ctx.fs.writeFileBytes(destination, contents);
  const entry: LogEntry = {
    kind: LogEntryKind.System,
    ts: nowIso(),
    message: `Attached ${basename(destination)}`,
    meta: {
      attachmentPath: destination,
      sourcePath: args.sourcePath,
    },
  };
  await appendLog(ctx, {
    taskId: args.taskId,
    entry,
  });
  return {
    attachmentPath: destination,
    entry,
  };
}

//#endregion
