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
const WORKTREE_PATH = '/repo-feature';
const TASK_ID = taskWorktreeId(PROJECT_ROOT, WORKTREE_PATH);

const ALWAYS_ALIVE: Signaller = {
  kill() {
    /* noop */
  },
  isAlive() {
    return true;
  },
};

const ALWAYS_DEAD: Signaller = {
  kill() {
    /* noop */
  },
  isAlive() {
    return false;
  },
};

function loadOnce(
  dir: string,
  signaller: Signaller,
  dbPath: string,
): ReturnType<typeof loadTaskTableDataWithWorktrees> {
  return loadTaskTableDataWithWorktrees(
    dir,
    [
      {
        projectRoot: PROJECT_ROOT,
        path: WORKTREE_PATH,
        branch: 'feature',
        headSha: null,
        current: true,
      },
    ],
    {
      openDatabase: () => openTasksDatabaseAtPath(dbPath),
      signaller,
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
      taskId: TASK_ID,
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE_PATH,
      branch: 'feature',
      title: 'feature',
    });
    seedAgentCiSession({
      opened,
      taskId: TASK_ID,
      sessionId: 'sess-run',
      pid: 1234,
    });
    opened.close();
    const data = loadOnce(dir, ALWAYS_ALIVE, dbPath);
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
      taskId: TASK_ID,
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE_PATH,
      branch: 'feature',
      title: 'feature',
    });
    seedAgentCiSession({
      opened,
      taskId: TASK_ID,
      sessionId: 'sess-pause',
      pid: 1235,
      pausedAt: '2026-04-01T00:00:00.000Z',
    });
    opened.close();
    const data = loadOnce(dir, ALWAYS_ALIVE, dbPath);
    expect(data.rows[0]?.agentCiStatus).toBe('paused');
  });

  test('row reports unavailable when active session has no pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-store-no-pid-'));
    const dbPath = join(dir, 'tasks.sqlite');
    const opened = openTasksDatabaseAtPath(dbPath);
    seedTask({
      opened,
      taskId: TASK_ID,
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE_PATH,
      branch: 'feature',
      title: 'feature',
    });
    seedAgentCiSession({
      opened,
      taskId: TASK_ID,
      sessionId: 'sess-no-pid',
      pid: null,
    });
    opened.close();
    const data = loadOnce(dir, ALWAYS_ALIVE, dbPath);
    expect(data.rows[0]?.agentCiStatus).toBe('unavailable');
    expect(data.rows[0]?.agentCiSessionId).toBeNull();
  });

  test('row reports unavailable when no active agent-ci session exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-store-empty-'));
    const dbPath = join(dir, 'tasks.sqlite');
    const opened = openTasksDatabaseAtPath(dbPath);
    seedTask({
      opened,
      taskId: TASK_ID,
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE_PATH,
      branch: 'feature',
      title: 'feature',
    });
    opened.close();
    const data = loadOnce(dir, ALWAYS_ALIVE, dbPath);
    expect(data.rows[0]?.agentCiStatus).toBe('unavailable');
  });

  test('stale-pid session is reconciled to failed and row reports unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-store-stale-'));
    const dbPath = join(dir, 'tasks.sqlite');
    const opened = openTasksDatabaseAtPath(dbPath);
    seedTask({
      opened,
      taskId: TASK_ID,
      projectRoot: PROJECT_ROOT,
      worktreePath: WORKTREE_PATH,
      branch: 'feature',
      title: 'feature',
    });
    seedAgentCiSession({
      opened,
      taskId: TASK_ID,
      sessionId: 'sess-stale',
      pid: 9999,
    });
    opened.close();
    const data = loadOnce(dir, ALWAYS_DEAD, dbPath);
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
});
