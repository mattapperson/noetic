/**
 * FS-backed task mutation policy for the agent harness.
 *
 * Blocks file mutations (write/edit/mutating shell commands) when the
 * agent is operating inside a tracked git repo at a path that does NOT
 * correspond to a registered task worktree. Forces agents (or the user)
 * to allocate a task-paired worktree before mutating sources.
 *
 * Uses the FS store (`tasks/<id>/task.json`) as the source of truth for
 * which paths are task worktrees. Reads are best-effort; on any IO error
 * we fall open (allow mutation) rather than risk locking the user out.
 */

import { resolve } from '@noetic/code-agent/tasks/path-utils';
import { TaskSource } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { listTasks } from '@noetic/code-agent/tasks/store/fs-node';
import type { ShellAdapter } from '@noetic/core';
import { createLocalFsAdapter } from '@noetic/core/adapters/node';
import type {
  MutationPolicy,
  MutationPolicyDecision,
  MutationPolicyRequest,
} from '../../tools/mutation-policy.js';
import { ALLOW_MUTATION, isProbablyMutatingShellCommand } from '../../tools/mutation-policy.js';

//#region Types

export interface CreateTaskMutationPolicyArgs {
  readonly sessionCwd: string;
  readonly shell: ShellAdapter;
  readonly enforceOnCleanRepo?: boolean;
  /** Test seam: inject a hermetic FS-backed task store. */
  readonly ctx?: TaskStoreContext;
}

interface GitRepoState {
  readonly inside: boolean;
  readonly dirty: boolean;
  readonly root: string;
}

//#endregion

//#region Helpers

function isMutatingRequest(request: MutationPolicyRequest): boolean {
  if (request.kind === 'write' || request.kind === 'edit') {
    return true;
  }
  if (request.kind === 'bash') {
    return isProbablyMutatingShellCommand(request.command ?? '');
  }
  return true;
}

async function gitRepoState(cwd: string, shell: ShellAdapter): Promise<GitRepoState> {
  const rootResult = await shell.exec('git rev-parse --show-toplevel', {
    cwd,
    timeout: 10,
  });
  if (rootResult.exitCode !== 0) {
    return {
      inside: false,
      dirty: false,
      root: cwd,
    };
  }
  const root = rootResult.stdout.trim();
  const status = await shell.exec('git status --porcelain', {
    cwd: root,
    timeout: 30,
  });
  return {
    inside: true,
    dirty: status.exitCode === 0 && status.stdout.trim().length > 0,
    root: root.length > 0 ? root : cwd,
  };
}

async function isTaskWorktree(args: { ctx: TaskStoreContext; repoRoot: string }): Promise<boolean> {
  const target = resolve(args.repoRoot);
  try {
    const tasks = await listTasks(args.ctx);
    for (const task of tasks) {
      if (task.source !== TaskSource.Worktree) {
        continue;
      }
      if (task.worktreePath === null) {
        continue;
      }
      if (resolve(task.worktreePath) !== target) {
        continue;
      }
      // Only treat as a task worktree when the task path differs from the
      // project root — the project root itself is never a "task worktree".
      if (resolve(task.projectRoot) === target) {
        continue;
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function denyMutation(request: MutationPolicyRequest, repoRoot: string): MutationPolicyDecision {
  const target = request.path ?? request.command ?? request.action ?? request.kind;
  return {
    allowed: false,
    message:
      `Blocked ${request.kind} mutation (${target}). This git repo has edits at ${repoRoot}; ` +
      'create or switch into a task-paired git worktree before making changes.',
  };
}

//#endregion

//#region Public API

export function createTaskMutationPolicy(args: CreateTaskMutationPolicyArgs): MutationPolicy {
  const ctx: TaskStoreContext = args.ctx ?? {
    fs: createLocalFsAdapter(),
    projectRoot: args.sessionCwd,
  };
  return {
    async check(request) {
      if (!isMutatingRequest(request)) {
        return ALLOW_MUTATION;
      }
      const repo = await gitRepoState(request.cwd, args.shell);
      if (!repo.inside) {
        return ALLOW_MUTATION;
      }
      if (!repo.dirty && args.enforceOnCleanRepo !== true) {
        return ALLOW_MUTATION;
      }
      if (
        await isTaskWorktree({
          ctx,
          repoRoot: repo.root,
        })
      ) {
        return ALLOW_MUTATION;
      }
      return denyMutation(request, repo.root);
    },
  };
}

//#endregion
