import type { ShellAdapter, ShellExecResult } from '@noetic/core';
import { createLocalShellAdapter } from '@noetic/core/adapters/node';

import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent, saveTask } from '../fs-store.js';
import type { Task } from '../schemas.js';
import { EventKind, TaskLifecycleStatus } from '../schemas.js';
import { execTolerantOfMissing, isShellMissing } from '../shell-utils.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

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

//#endregion

//#region Helpers

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

//#endregion

//#region Public API

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
