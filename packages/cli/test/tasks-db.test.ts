import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { TasksDatabase } from '../src/commands/builtins/tasks/db/index.js';
import { openTasksDatabaseAtPath } from '../src/commands/builtins/tasks/db/index.js';
import { taskSessions, tasks } from '../src/commands/builtins/tasks/db/schema.js';
import { loadTaskTableDataWithWorktrees } from '../src/commands/builtins/tasks/store.js';

describe('tasks db', () => {
  test('models one task per worktree with many sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-tasks-db-'));
    const opened = openTasksDatabaseAtPath(join(dir, 'tasks.sqlite'));
    const now = new Date().toISOString();

    try {
      opened.db
        .insert(tasks)
        .values({
          id: 'task-1',
          projectRoot: '/repo',
          worktreePath: '/repo-feature',
          title: 'feature',
          branch: 'feature',
          headSha: 'abc123',
          reviewStatus: 'not_started',
          source: 'git-worktree',
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
        })
        .run();

      opened.db
        .insert(taskSessions)
        .values([
          {
            id: 'task-session-1',
            taskId: 'task-1',
            sessionId: 'session-1',
            kind: 'agent_ci_review',
            status: 'active',
            title: 'First review',
            startedAt: now,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'task-session-2',
            taskId: 'task-1',
            sessionId: 'session-2',
            kind: 'local_review',
            status: 'completed',
            title: 'Second review',
            startedAt: now,
            completedAt: now,
            createdAt: now,
            updatedAt: now,
          },
        ])
        .run();

      const task = opened.db.query.tasks
        .findFirst({
          where: eq(tasks.id, 'task-1'),
          with: {
            sessions: true,
          },
        })
        .sync();

      expect(task?.sessions).toHaveLength(2);

      opened.db.delete(tasks).where(eq(tasks.id, 'task-1')).run();
      expect(opened.db.select().from(taskSessions).all()).toHaveLength(0);
    } finally {
      opened.close();
    }
  });

  test('enforces one task per worktree path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-tasks-db-'));
    const opened = openTasksDatabaseAtPath(join(dir, 'tasks.sqlite'));
    const now = new Date().toISOString();

    try {
      const base = {
        projectRoot: '/repo',
        worktreePath: '/repo-feature',
        title: 'feature',
        branch: 'feature',
        headSha: 'abc123',
        reviewStatus: 'not_started' as const,
        source: 'git-worktree' as const,
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      };

      opened.db
        .insert(tasks)
        .values({
          ...base,
          id: 'task-1',
        })
        .run();

      expect(() =>
        opened.db
          .insert(tasks)
          .values({
            ...base,
            id: 'task-2',
            projectRoot: '/other-repo',
          })
          .run(),
      ).toThrow();
    } finally {
      opened.close();
    }
  });

  test('task table returns one row per active worktree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-tasks-table-'));
    const opened = openTasksDatabaseAtPath(join(dir, 'tasks.sqlite'));
    opened.close();

    const openDatabase = (): TasksDatabase => openTasksDatabaseAtPath(join(dir, 'tasks.sqlite'));

    const first = loadTaskTableDataWithWorktrees(
      dir,
      [
        {
          projectRoot: '/repo',
          path: '/repo',
          branch: 'main',
          headSha: 'aaa',
          current: true,
        },
        {
          projectRoot: '/repo',
          path: '/repo-feature',
          branch: 'feature',
          headSha: 'bbb',
          current: false,
        },
      ],
      openDatabase,
    );

    expect(first.projectRoot).toBe('/repo');
    expect(first.rows).toHaveLength(2);
    expect(first.rows.map((row) => row.worktreePath)).toEqual([
      '/repo',
      '/repo-feature',
    ]);

    const second = loadTaskTableDataWithWorktrees(
      dir,
      [
        {
          projectRoot: '/repo',
          path: '/repo',
          branch: 'main',
          headSha: 'aaa',
          current: true,
        },
      ],
      openDatabase,
    );

    expect(second.rows.map((row) => row.worktreePath)).toEqual([
      '/repo',
    ]);
  });
});
