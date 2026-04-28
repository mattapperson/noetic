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
          status: 'active',
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
        status: 'active' as const,
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
          path: '/repo-feature',
          branch: 'feature',
          headSha: 'bbb',
          current: false,
        },
        {
          projectRoot: '/repo',
          path: '/repo-bugfix',
          branch: 'bugfix',
          headSha: 'ccc',
          current: true,
        },
      ],
      openDatabase,
    );

    expect(first.projectRoot).toBe('/repo');
    expect(first.rows).toHaveLength(2);
    expect(first.rows.map((row) => row.worktreePath)).toEqual([
      '/repo-bugfix',
      '/repo-feature',
    ]);

    const second = loadTaskTableDataWithWorktrees(dir, [], openDatabase);

    expect(second.rows).toEqual([]);
  });

  test('task table backfills worktrees created outside Noetic', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-tasks-backfill-'));
    const dbPath = join(dir, 'tasks.sqlite');
    openTasksDatabaseAtPath(dbPath).close();
    const openDatabase = (): TasksDatabase => openTasksDatabaseAtPath(dbPath);

    const data = loadTaskTableDataWithWorktrees(
      dir,
      [
        {
          projectRoot: '/repo',
          path: '/repo-external',
          branch: 'external/tool',
          headSha: 'bbb',
          current: false,
        },
      ],
      openDatabase,
    );

    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]?.title).toBe('external/tool');

    const opened = openDatabase();
    try {
      const stored = opened.db.select().from(tasks).all();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.worktreePath).toBe('/repo-external');
    } finally {
      opened.close();
    }
  });

  test('stale worktree rows are marked removed and omitted from active table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-tasks-stale-'));
    const dbPath = join(dir, 'tasks.sqlite');
    const opened = openTasksDatabaseAtPath(dbPath);
    const now = new Date().toISOString();
    opened.db
      .insert(tasks)
      .values({
        id: 'task-stale',
        projectRoot: '/repo',
        worktreePath: '/repo-stale',
        title: 'stale',
        branch: 'stale',
        headSha: 'old',
        reviewStatus: 'not_started',
        status: 'active',
        source: 'git-worktree',
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      })
      .run();
    opened.close();

    const openDatabase = (): TasksDatabase => openTasksDatabaseAtPath(dbPath);
    const data = loadTaskTableDataWithWorktrees(
      dir,
      [
        {
          projectRoot: '/repo',
          path: '/repo-feature',
          branch: 'feature',
          headSha: 'new',
          current: true,
        },
      ],
      openDatabase,
    );

    expect(data.rows.map((row) => row.worktreePath)).toEqual([
      '/repo-feature',
    ]);

    const after = openDatabase();
    try {
      const stale = after.db.select().from(tasks).where(eq(tasks.id, 'task-stale')).get();
      expect(stale?.status).toBe('removed');
    } finally {
      after.close();
    }
  });
});
