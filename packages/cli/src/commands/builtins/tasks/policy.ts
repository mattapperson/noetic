import { basename, resolve } from 'node:path';
import type { ShellAdapter } from '@noetic/core';
import { and, eq } from 'drizzle-orm';

import type {
  MutationPolicy,
  MutationPolicyDecision,
  MutationPolicyRequest,
} from '../../../tools/mutation-policy.js';
import { ALLOW_MUTATION, isProbablyMutatingShellCommand } from '../../../tools/mutation-policy.js';
import { openTasksDatabase } from './db/index.js';
import { tasks, taskWorktreeId } from './db/schema.js';

interface CreateTaskMutationPolicyArgs {
  sessionCwd: string;
  shell: ShellAdapter;
  enforceOnCleanRepo?: boolean;
}

export function createTaskMutationPolicy(args: CreateTaskMutationPolicyArgs): MutationPolicy {
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
          repoRoot: repo.root,
          sessionCwd: args.sessionCwd,
        })
      ) {
        return ALLOW_MUTATION;
      }
      return denyMutation(request, repo.root);
    },
  };
}

function isMutatingRequest(request: MutationPolicyRequest): boolean {
  if (request.kind === 'write' || request.kind === 'edit') {
    return true;
  }
  if (request.kind === 'bash') {
    return isProbablyMutatingShellCommand(request.command ?? '');
  }
  return true;
}

interface GitRepoState {
  inside: boolean;
  dirty: boolean;
  root: string;
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

async function isTaskWorktree(args: { repoRoot: string; sessionCwd: string }): Promise<boolean> {
  const opened = openTasksDatabase(args.sessionCwd);
  try {
    const row = opened.db
      .select({
        projectRoot: tasks.projectRoot,
        worktreePath: tasks.worktreePath,
      })
      .from(tasks)
      .where(and(eq(tasks.worktreePath, resolve(args.repoRoot)), eq(tasks.source, 'git-worktree')))
      .limit(1)
      .get();
    return row !== undefined && resolve(row.projectRoot) !== resolve(row.worktreePath);
  } finally {
    opened.close();
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

export async function ensureTaskForWorktree(args: {
  sessionCwd: string;
  worktreePath: string;
  projectRoot: string;
  branch?: string | null;
}): Promise<void> {
  const opened = openTasksDatabase(args.sessionCwd);
  try {
    const now = new Date().toISOString();
    const worktreePath = resolve(args.worktreePath);
    const projectRoot = resolve(args.projectRoot);
    const title = args.branch ?? (basename(worktreePath) || worktreePath);
    const branch = args.branch ?? null;
    opened.db
      .insert(tasks)
      .values({
        id: taskWorktreeId(projectRoot, worktreePath),
        projectRoot,
        worktreePath,
        title,
        branch,
        headSha: null,
        reviewStatus: 'not_started',
        source: 'git-worktree',
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      })
      .onConflictDoUpdate({
        target: tasks.worktreePath,
        set: {
          title,
          branch,
          updatedAt: now,
          lastSeenAt: now,
        },
      })
      .run();
  } finally {
    opened.close();
  }
}
