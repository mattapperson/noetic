/**
 * Typed errors emitted by the teammate / worktree subsystem.
 *
 * Every error path the agent or worktree adapter can hit goes through one of
 * these factories so consumers can negative-test by code (per `.claude/rules/
 * testing.md` invariant 1) and downstream UIs can render an actionable hint.
 */

import { NoeticConfigError } from '@noetic-tools/core';

//#region Codes

export const WorktreeErrorCode = {
  UnknownAgentType: 'UNKNOWN_AGENT_TYPE',
  WorktreeNoDefaultBranch: 'WORKTREE_NO_DEFAULT_BRANCH',
  WorktreeNotGitRepo: 'WORKTREE_NOT_GIT_REPO',
  WorktreeAddFailed: 'WORKTREE_ADD_FAILED',
  WorktreeRemoveFailed: 'WORKTREE_REMOVE_FAILED',
  WorktreeHookFailed: 'WORKTREE_HOOK_FAILED',
} as const;

export type WorktreeErrorCode = (typeof WorktreeErrorCode)[keyof typeof WorktreeErrorCode];

//#endregion

//#region Factories

export function unknownAgentType(args: {
  requested: string;
  available: ReadonlyArray<string>;
}): NoeticConfigError {
  const list = args.available.length > 0 ? args.available.join(', ') : '(none registered)';
  return new NoeticConfigError({
    code: WorktreeErrorCode.UnknownAgentType,
    message: `Unknown subagent_type '${args.requested}'. Available: ${list}`,
    hint: 'Pass one of the available agent types, or register a new skill with `agent-type` set.',
  });
}

export function worktreeNoDefaultBranch(): NoeticConfigError {
  return new NoeticConfigError({
    code: WorktreeErrorCode.WorktreeNoDefaultBranch,
    message: 'Could not determine default branch.',
    hint: 'Set `worktree.branch` in noetic.config.ts to override, or ensure your repo has an `origin/HEAD` symbolic ref or local `main`/`master`.',
  });
}

export function worktreeNotGitRepo(cwd: string): NoeticConfigError {
  return new NoeticConfigError({
    code: WorktreeErrorCode.WorktreeNotGitRepo,
    message: `Not inside a git repository: ${cwd}`,
    hint: "Run the CLI from inside a git repository, or remove `isolation: 'worktree'` from the agent call.",
  });
}

export function worktreeAddFailed(stderr: string): NoeticConfigError {
  return new NoeticConfigError({
    code: WorktreeErrorCode.WorktreeAddFailed,
    message: `git worktree add failed: ${stderr}`,
    hint: 'Check that the target path is writable and that the branch name is not already in use.',
  });
}

export function worktreeRemoveFailed(stderr: string): NoeticConfigError {
  return new NoeticConfigError({
    code: WorktreeErrorCode.WorktreeRemoveFailed,
    message: `git worktree remove failed: ${stderr}`,
    hint: 'The worktree may have uncommitted changes. Inspect it on disk and remove manually if needed.',
  });
}

export function worktreeHookFailed(args: { hook: string; detail: string }): NoeticConfigError {
  return new NoeticConfigError({
    code: WorktreeErrorCode.WorktreeHookFailed,
    message: `worktree hook '${args.hook}' failed: ${args.detail}`,
    hint: 'Fix the hook command in `worktree.{pre-start,post-start,post-merge,pre-remove}` config, or remove the failing hook.',
  });
}

//#endregion
