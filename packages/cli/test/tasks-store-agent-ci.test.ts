import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';

import type { Signaller } from '../src/commands/builtins/tasks/agent-ci-control.js';
import { openTasksDatabaseAtPath } from '../src/commands/builtins/tasks/db/index.js';
import { taskSessions, taskWorktreeId } from '../src/commands/builtins/tasks/db/schema.js';
import { loadTaskTableDataWithWorktrees } from '../src/commands/builtins/tasks/store.js';
import { seedAgentCiSession, seedTask } from './_helpers.js';

const PROJECT_ROOT = '/repo';
const WORKTREE_PATH_A = '/repo-feature';
const WORKTREE_PATH_B = '/repo-bugfix';
const TASK_ID_A = taskWorktreeId(PROJECT_ROOT, WORKTREE_PATH_A);
const TASK_ID_B = taskWorktreeId(PROJECT_ROOT, WORKTREE_PATH_B);

const ALWAYS_ALIVE: Signaller = {
  kill() {
    /* noop */
  },
  isAlive() {
    return true;
  },
  startTime() {
    return 'STABLE';
  },
};

const ALWAYS_DEAD: Signaller = {
  kill() {
    /* noop */
  },
  isAlive() {
    return false;
  },
  startTime() {
    return null;
  },
};

interface LoadOnceArgs {
  dir: string;
  signaller: Signaller;
  dbPath: string;
  worktrees?: ReadonlyArray<{
    projectRoot: string;
    path: string;
    branch: string | null;
    headSha: string | null;
    current: boolean;
  }>;
}

function loadOnce(args: LoadOnceArgs): ReturnType<typeof loadTaskTableDataWithWorktrees> {
  const worktrees = args.worktrees ?? [
    {
      projectRoot: PROJECT_ROOT,
      path: WORKTREE_PATH_A,
      branch: 'feature',
      headSha: null,
      current: true,
    },
  ];
  return loadTaskTableDataWithWorktrees(
    args.dir,
    [
      ...worktrees,
    ],
    {
      openDatabase: () => openTasksDatabaseAtPath(args.dbPath),
      signaller: args.signaller,
    },
  );
}

describe('tasks store agent-ci derivations', () => {
  test('row reports running when active session has pid and no pausedAt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-store-running-'));
    const dbPath = join(dir, 'tasks.sqlite');
    const opened = openTasksDatabaseAtPath(dbPath);
    seedTask({
      opened,
      taskId: TASK_ID_A,
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE_PATH_A,
      branch: 'feature',
      title: 'feature',
    });
    seedAgentCiSession({
      opened,
      taskId: TASK_ID_A,
      sessionId: 'sess-run',
      pid: 1234,
      pidStarttime: 'STABLE',
    });
    opened.close();
    const data = loadOnce({
      dir,
      signaller: ALWAYS_ALIVE,
      dbPath,
    });
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]?.agentCiStatus).toBe('running');
    expect(data.rows[0]?.agentCiSessionId).toBe('sess-run');
    expect(data.rows[0]?.agentCiPid).toBe(1234);
  });

  test('row reports paused when active session has pausedAt set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-store-paused-'));
    const dbPath = join(dir, 'tasks.sqlite');
    const opened = openTasksDatabaseAtPath(dbPath);
    seedTask({
      opened,
      taskId: TASK_ID_A,
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE_PATH_A,
      branch: 'feature',
      title: 'feature',
    });
    seedAgentCiSession({
      opened,
      taskId: TASK_ID_A,
      sessionId: 'sess-pause',
      pid: 1235,
      pausedAt: '2026-04-01T00:00:00.000Z',
      pidStarttime: 'STABLE',
    });
    opened.close();
    const data = loadOnce({
      dir,
      signaller: ALWAYS_ALIVE,
      dbPath,
    });
    expect(data.rows[0]?.agentCiStatus).toBe('paused');
  });

  test('row reports unavailable when active session has no pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-store-no-pid-'));
    const dbPath = join(dir, 'tasks.sqlite');
    const opened = openTasksDatabaseAtPath(dbPath);
    seedTask({
      opened,
      taskId: TASK_ID_A,
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE_PATH_A,
      branch: 'feature',
      title: 'feature',
    });
    seedAgentCiSession({
      opened,
      taskId: TASK_ID_A,
      sessionId: 'sess-no-pid',
      pid: null,
    });
    opened.close();
    const data = loadOnce({
      dir,
      signaller: ALWAYS_ALIVE,
      dbPath,
    });
    expect(data.rows[0]?.agentCiStatus).toBe('unavailable');
    expect(data.rows[0]?.agentCiSessionId).toBeNull();
  });

  test('row reports unavailable when no active agent-ci session exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-store-empty-'));
    const dbPath = join(dir, 'tasks.sqlite');
    const opened = openTasksDatabaseAtPath(dbPath);
    seedTask({
      opened,
      taskId: TASK_ID_A,
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE_PATH_A,
      branch: 'feature',
      title: 'feature',
    });
    opened.close();
    const data = loadOnce({
      dir,
      signaller: ALWAYS_ALIVE,
      dbPath,
    });
    expect(data.rows[0]?.agentCiStatus).toBe('unavailable');
  });

  test('stale-pid session is reconciled to failed and row reports unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-store-stale-'));
    const dbPath = join(dir, 'tasks.sqlite');
    const opened = openTasksDatabaseAtPath(dbPath);
    seedTask({
      opened,
      taskId: TASK_ID_A,
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE_PATH_A,
      branch: 'feature',
      title: 'feature',
    });
    seedAgentCiSession({
      opened,
      taskId: TASK_ID_A,
      sessionId: 'sess-stale',
      pid: 9999,
      pidStarttime: 'STABLE',
    });
    opened.close();
    const data = loadOnce({
      dir,
      signaller: ALWAYS_DEAD,
      dbPath,
    });
    expect(data.rows[0]?.agentCiStatus).toBe('unavailable');
    const after = openTasksDatabaseAtPath(dbPath);
    try {
      const row = after.db
        .select()
        .from(taskSessions)
        .where(eq(taskSessions.id, 'sess-stale'))
        .get();
      expect(row?.status).toBe('failed');
      expect(row?.completedAt).not.toBeNull();
    } finally {
      after.close();
    }
  });

  test('multiple tasks each show their own newest active agent-ci session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-store-multi-'));
    const dbPath = join(dir, 'tasks.sqlite');
    const opened = openTasksDatabaseAtPath(dbPath);
    seedTask({
      opened,
      taskId: TASK_ID_A,
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE_PATH_A,
      branch: 'feature',
      title: 'feature',
    });
    seedTask({
      opened,
      taskId: TASK_ID_B,
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE_PATH_B,
      branch: 'bugfix',
      title: 'bugfix',
    });
    seedAgentCiSession({
      opened,
      taskId: TASK_ID_A,
      sessionId: 'a-old',
      pid: 1100,
      pidStarttime: 'STABLE',
      startedAt: '2026-01-01T00:00:00.000Z',
    });
    seedAgentCiSession({
      opened,
      taskId: TASK_ID_A,
      sessionId: 'a-new',
      pid: 1101,
      pidStarttime: 'STABLE',
      startedAt: '2026-02-01T00:00:00.000Z',
    });
    seedAgentCiSession({
      opened,
      taskId: TASK_ID_B,
      sessionId: 'b-only',
      pid: 1200,
      pausedAt: '2026-03-01T00:00:00.000Z',
      pidStarttime: 'STABLE',
      startedAt: '2026-03-01T00:00:00.000Z',
    });
    opened.close();
    const data = loadOnce({
      dir,
      signaller: ALWAYS_ALIVE,
      dbPath,
      worktrees: [
        {
          projectRoot: PROJECT_ROOT,
          path: WORKTREE_PATH_A,
          branch: 'feature',
          headSha: null,
          current: false,
        },
        {
          projectRoot: PROJECT_ROOT,
          path: WORKTREE_PATH_B,
          branch: 'bugfix',
          headSha: null,
          current: true,
        },
      ],
    });
    const byPath = new Map(
      data.rows.map((row) => [
        row.worktreePath,
        row,
      ]),
    );
    const rowA = byPath.get(WORKTREE_PATH_A);
    const rowB = byPath.get(WORKTREE_PATH_B);
    expect(rowA?.agentCiStatus).toBe('running');
    expect(rowA?.agentCiSessionId).toBe('a-new');
    expect(rowA?.agentCiPid).toBe(1101);
    expect(rowB?.agentCiStatus).toBe('paused');
    expect(rowB?.agentCiSessionId).toBe('b-only');
  });
});
