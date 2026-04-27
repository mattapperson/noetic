import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

import type { CommandResult } from '../src/commands/builtins/tasks/cleanup.js';
import { cleanupMergedWorktreesForProject } from '../src/commands/builtins/tasks/cleanup.js';
import type { TasksDatabase } from '../src/commands/builtins/tasks/db/index.js';
import { openTasksDatabaseAtPath } from '../src/commands/builtins/tasks/db/index.js';
import { tasks } from '../src/commands/builtins/tasks/db/schema.js';

describe('tasks cleanup', () => {
  test('dirty merged worktree is marked cleanup-blocked and not removed', async () => {
    const { openDatabase, commands } = taskDbWithRow('dirty');

    await cleanupMergedWorktreesForProject({
      cwd: '/repo',
      projectRoot: '/repo',
      openDatabase,
      run: async ({ args }) => {
        commands.push(args.join(' '));
        if (args.join(' ') === 'status --porcelain') {
          return ok(' M file.ts\n');
        }
        if (args.includes('symbolic-ref')) {
          return ok('origin/main\n');
        }
        if (args.includes('show-ref') || args.includes('merge-base')) {
          return ok('');
        }
        return ok('');
      },
    });

    const row = readTask(openDatabase, 'task-dirty');
    expect(row?.status).toBe('cleanup-blocked');
    expect(row?.cleanupReason).toContain('uncommitted changes');
    expect(commands).not.toContain('worktree remove /repo-dirty');
  });

  test('local-merged clean worktree cleanup removes worktree and deletes branch', async () => {
    const { openDatabase, commands } = taskDbWithRow('merged');

    const result = await cleanupMergedWorktreesForProject({
      cwd: '/repo',
      projectRoot: '/repo',
      openDatabase,
      run: async ({ args }) => {
        commands.push(args.join(' '));
        if (args.join(' ') === 'status --porcelain') {
          return ok('');
        }
        if (args.includes('symbolic-ref')) {
          return ok('origin/main\n');
        }
        if (args.includes('show-ref') || args.includes('merge-base')) {
          return ok('');
        }
        return ok('');
      },
    });

    expect(result.removed).toBe(1);
    expect(commands).toContain('worktree remove /repo-merged');
    expect(commands).toContain('branch -d feature/merged');

    const row = readTask(openDatabase, 'task-merged');
    expect(row?.status).toBe('merged');
    expect(row?.cleanupReason).toContain('merged into main');
  });

  test('provider-merged clean worktree cleanup uses gh output', async () => {
    const { openDatabase, commands } = taskDbWithRow('provider');

    const result = await cleanupMergedWorktreesForProject({
      cwd: '/repo',
      projectRoot: '/repo',
      openDatabase,
      run: async ({ command, args }) => {
        commands.push(`${command} ${args.join(' ')}`);
        if (command === 'git' && args.join(' ') === 'status --porcelain') {
          return ok('');
        }
        if (command === 'git' && args.includes('symbolic-ref')) {
          return ok('origin/main\n');
        }
        if (command === 'git' && args.includes('show-ref')) {
          return ok('');
        }
        if (command === 'git' && args.includes('merge-base')) {
          return fail('not ancestor');
        }
        if (command === 'git' && args.includes('@{u}')) {
          return ok('origin/feature/provider\n');
        }
        if (command === 'gh' && args.join(' ') === 'auth status') {
          return ok('authenticated');
        }
        if (command === 'gh' && args.includes('view')) {
          return ok(
            JSON.stringify({
              number: 42,
              url: 'https://example.test/pr/42',
              state: 'MERGED',
            }),
          );
        }
        return ok('');
      },
    });

    expect(result.removed).toBe(1);
    expect(commands).toContain('git worktree remove /repo-provider');
    expect(commands).toContain('git branch -D feature/provider');

    const row = readTask(openDatabase, 'task-provider');
    expect(row?.status).toBe('merged');
    expect(row?.provider).toBe('github');
    expect(row?.providerId).toBe('42');
  });

  test('cleanup-blocked clean worktree is retried and removed', async () => {
    const { openDatabase } = taskDbWithRow('retry', {
      status: 'cleanup-blocked',
      cleanupReason: 'worktree has uncommitted changes',
    });

    const result = await cleanupMergedWorktreesForProject({
      cwd: '/repo',
      projectRoot: '/repo',
      openDatabase,
      run: async ({ args }) => {
        if (args.join(' ') === 'status --porcelain') {
          return ok('');
        }
        if (args.includes('symbolic-ref')) {
          return ok('origin/main\n');
        }
        if (args.includes('show-ref') || args.includes('merge-base')) {
          return ok('');
        }
        return ok('');
      },
    });

    expect(result.removed).toBe(1);
    const row = readTask(openDatabase, 'task-retry');
    expect(row?.status).toBe('merged');
  });

  test('provider-merged path uses timeouts for gh calls', async () => {
    const { openDatabase } = taskDbWithRow('timeout');
    const providerTimeouts: number[] = [];

    await cleanupMergedWorktreesForProject({
      cwd: '/repo',
      projectRoot: '/repo',
      openDatabase,
      run: async ({ command, args, timeoutMs }) => {
        if (command === 'gh') {
          providerTimeouts.push(timeoutMs ?? 0);
        }
        if (command === 'git' && args.join(' ') === 'status --porcelain') {
          return ok('');
        }
        if (command === 'git' && args.includes('symbolic-ref')) {
          return ok('origin/main\n');
        }
        if (command === 'git' && args.includes('show-ref')) {
          return ok('');
        }
        if (command === 'git' && args.includes('merge-base')) {
          return fail('not ancestor');
        }
        if (command === 'git' && args.includes('@{u}')) {
          return ok('origin/feature/timeout\n');
        }
        if (command === 'gh' && args.join(' ') === 'auth status') {
          return fail('not authenticated');
        }
        return fail('unavailable');
      },
    });

    expect(providerTimeouts).toEqual([
      15_000,
    ]);
  });
});

function taskDbWithRow(
  name: string,
  overrides: Partial<{
    status: 'active' | 'merged' | 'cleanup-blocked' | 'removed';
    cleanupReason: string | null;
  }> = {},
): {
  openDatabase: () => TasksDatabase;
  commands: string[];
} {
  const dir = mkdtempSync(join(tmpdir(), 'noetic-tasks-cleanup-'));
  const path = join(dir, 'tasks.sqlite');
  const opened = openTasksDatabaseAtPath(path);
  const now = new Date().toISOString();
  opened.db
    .insert(tasks)
    .values({
      id: `task-${name}`,
      projectRoot: '/repo',
      worktreePath: `/repo-${name}`,
      title: `feature/${name}`,
      branch: `feature/${name}`,
      headSha: 'abc123',
      reviewStatus: 'not_started',
      status: overrides.status ?? 'active',
      source: 'git-worktree',
      cleanupReason: overrides.cleanupReason ?? null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    })
    .run();
  opened.close();

  return {
    openDatabase: () => openTasksDatabaseAtPath(path),
    commands: [],
  };
}

function readTask(openDatabase: () => TasksDatabase, id: string) {
  const opened = openDatabase();
  try {
    return opened.db.select().from(tasks).where(eq(tasks.id, id)).get();
  } finally {
    opened.close();
  }
}

function ok(stdout: string): CommandResult {
  return {
    code: 0,
    stdout,
    stderr: '',
  };
}

function fail(stderr: string): CommandResult {
  return {
    code: 1,
    stdout: '',
    stderr,
  };
}
