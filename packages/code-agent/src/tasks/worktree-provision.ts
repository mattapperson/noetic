/**
 * Provision a worktree for a feature implementation. Tries `wt switch
 * -c <branch>` (worktrunk, the project's preferred tool) first; falls
 * back to `git worktree add <projectRoot>/.worktrees/<branch> -b <branch>`
 * if `wt` is missing or rejects. If a worktree for the branch already
 * exists, returns its path without creating a new one.
 *
 * The implementer launcher calls this once per triaged feature so the
 * react()-driven implementation agent has an isolated checkout to
 * write into. The reconcile flow watches `git worktree list` for the
 * resulting path.
 */

import type { ShellAdapter, ShellExecResult } from '@noetic-tools/core';

import { parseWorktreeList } from './git.js';
import { join, resolve } from './path-utils.js';
import { execTolerantOfMissing, isShellMissing } from './shell-utils.js';

//#region Types

export interface ProvisionWorktreeArgs {
  readonly projectRoot: string;
  readonly branch: string;
  /** Working directory for `wt`/`git` calls. Defaults to {@link projectRoot}. */
  readonly cwd?: string;
  /**
   * Shell used to invoke `wt` and `git`. Required — the SDK stays
   * portable by never reaching for a local adapter implicitly. CLI
   * callers pass `createLocalShellAdapter()`.
   */
  readonly shell: ShellAdapter;
}

/** Records which tool produced the worktree, for audit and event payloads. */
export const ProvisionTool = {
  Wt: 'wt',
  Git: 'git',
  Reused: 'reused',
} as const;

export type ProvisionTool = (typeof ProvisionTool)[keyof typeof ProvisionTool];

export interface ProvisionWorktreeResult {
  readonly worktreePath: string;
  readonly branch: string;
  readonly tool: ProvisionTool;
}

/**
 * Thrown when neither `wt` nor `git worktree add` could produce a
 * worktree for the branch. The original shell results are attached as
 * `cause` so callers can surface them in audit logs.
 */
export class WorktreeProvisionError extends Error {
  readonly wtResult: ShellExecResult | null;
  readonly gitResult: ShellExecResult | null;

  constructor(
    message: string,
    detail: {
      wtResult: ShellExecResult | null;
      gitResult: ShellExecResult | null;
    },
  ) {
    super(message, {
      cause: detail,
    });
    this.name = 'WorktreeProvisionError';
    this.wtResult = detail.wtResult;
    this.gitResult = detail.gitResult;
  }
}

//#endregion

//#region Helpers

/**
 * Strict allowlist for branch names that go directly into shell-string
 * commands. The git ref-format spec is wider; this is the safe subset
 * we accept. Rejects shell metacharacters (`;`, `&`, `|`, `$`, backticks,
 * spaces, etc.), `..` (path traversal), leading `-` (option-injection
 * into `wt`/`git`), and leading/trailing/double slashes.
 */
const SAFE_BRANCH_RE = /^[A-Za-z0-9_.][A-Za-z0-9_.\-/]*$/;

function isSafeBranchName(branch: string): boolean {
  if (branch.length === 0) {
    return false;
  }
  if (!SAFE_BRANCH_RE.test(branch)) {
    return false;
  }
  if (branch.includes('..')) {
    return false;
  }
  if (branch.endsWith('/') || branch.endsWith('.')) {
    return false;
  }
  if (branch.includes('//')) {
    return false;
  }
  return true;
}

function normalizeBranchRef(ref: string | null): string | null {
  if (ref === null) {
    return null;
  }
  return ref.replace(/^refs\/heads\//, '');
}

/**
 * Look up an existing worktree for `branch` from `git worktree list
 * --porcelain`. Returns null when the branch has no live worktree (or
 * `git` is unavailable, in which case the caller will surface the
 * provisioning error from the create attempt).
 */
async function findExistingWorktreePath(args: {
  shell: ShellAdapter;
  cwd: string;
  branch: string;
}): Promise<string | null> {
  const result = await execTolerantOfMissing(args.shell, 'git worktree list --porcelain', args.cwd);
  if (result.exitCode !== 0) {
    return null;
  }
  const records = parseWorktreeList(result.stdout).filter(
    (record) => !record.bare && !record.prunable,
  );
  for (const record of records) {
    if (normalizeBranchRef(record.branchRef) === args.branch) {
      return resolve(record.path);
    }
  }
  return null;
}

async function tryWtSwitch(args: { shell: ShellAdapter; cwd: string; branch: string }): Promise<{
  ok: boolean;
  result: ShellExecResult;
}> {
  const result = await execTolerantOfMissing(args.shell, `wt switch -c ${args.branch}`, args.cwd);
  if (result.exitCode === 0) {
    return {
      ok: true,
      result,
    };
  }
  // `wt` exited non-zero — could be missing-binary or genuine failure.
  // Either way, fall back to `git worktree add`; the caller surfaces
  // both results if the fallback also fails.
  return {
    ok: false,
    result,
  };
}

async function tryGitWorktreeAdd(args: {
  shell: ShellAdapter;
  cwd: string;
  branch: string;
  worktreePath: string;
}): Promise<{
  ok: boolean;
  result: ShellExecResult;
}> {
  const result = await execTolerantOfMissing(
    args.shell,
    `git worktree add ${args.worktreePath} -b ${args.branch}`,
    args.cwd,
  );
  return {
    ok: result.exitCode === 0,
    result,
  };
}

function defaultWorktreePath(projectRoot: string, branch: string): string {
  return join(projectRoot, '.worktrees', branch);
}

//#endregion

//#region Public API

/**
 * Provision (or reuse) a worktree for {@link ProvisionWorktreeArgs.branch}.
 * Order of preference:
 *
 *   1. If a worktree for the branch already exists, reuse it.
 *   2. Try `wt switch -c <branch>`. On success, look up the resulting
 *      worktree path via `git worktree list`.
 *   3. Fall back to `git worktree add <projectRoot>/.worktrees/<branch>
 *      -b <branch>`.
 *
 * Throws {@link WorktreeProvisionError} when both create attempts fail.
 */
export async function provisionWorktree(
  args: ProvisionWorktreeArgs,
): Promise<ProvisionWorktreeResult> {
  if (!isSafeBranchName(args.branch)) {
    throw new WorktreeProvisionError(
      `Refusing to provision worktree for unsafe branch name: ${JSON.stringify(args.branch)}`,
      {
        wtResult: null,
        gitResult: null,
      },
    );
  }
  const cwd = args.cwd ?? args.projectRoot;
  const shell = args.shell;

  const existing = await findExistingWorktreePath({
    shell,
    cwd,
    branch: args.branch,
  });
  if (existing !== null) {
    return {
      worktreePath: existing,
      branch: args.branch,
      tool: ProvisionTool.Reused,
    };
  }

  const wtAttempt = await tryWtSwitch({
    shell,
    cwd,
    branch: args.branch,
  });
  if (wtAttempt.ok) {
    const path = await findExistingWorktreePath({
      shell,
      cwd,
      branch: args.branch,
    });
    if (path !== null) {
      return {
        worktreePath: path,
        branch: args.branch,
        tool: ProvisionTool.Wt,
      };
    }
    // `wt switch` reported success but `git worktree list` can't see
    // the new worktree — fall through to the git path so we don't
    // silently lose the branch.
  }

  const fallbackPath = defaultWorktreePath(args.projectRoot, args.branch);
  const gitAttempt = await tryGitWorktreeAdd({
    shell,
    cwd,
    branch: args.branch,
    worktreePath: fallbackPath,
  });
  if (gitAttempt.ok) {
    return {
      worktreePath: fallbackPath,
      branch: args.branch,
      tool: ProvisionTool.Git,
    };
  }

  const wtMissing = isShellMissing(wtAttempt.result);
  const wtSummary = wtMissing
    ? '`wt` not found on PATH'
    : `wt switch failed (exit ${wtAttempt.result.exitCode ?? 'null'}): ${
        wtAttempt.result.stderr || wtAttempt.result.stdout
      }`;
  const gitSummary = `git worktree add failed (exit ${gitAttempt.result.exitCode ?? 'null'}): ${
    gitAttempt.result.stderr || gitAttempt.result.stdout
  }`;
  throw new WorktreeProvisionError(
    `Could not provision worktree for ${args.branch}: ${wtSummary}; ${gitSummary}`,
    {
      wtResult: wtAttempt.result,
      gitResult: gitAttempt.result,
    },
  );
}

//#endregion
