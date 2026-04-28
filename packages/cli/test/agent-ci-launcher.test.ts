import { afterEach, describe, expect, test } from 'bun:test';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';

import type { AgentCiSpawn } from '../src/commands/builtins/tasks/agent-ci-launcher.js';
import { startAgentCiRun } from '../src/commands/builtins/tasks/agent-ci-launcher.js';
import { openTasksDatabaseAtPath } from '../src/commands/builtins/tasks/db/index.js';
import { taskSessions, tasks } from '../src/commands/builtins/tasks/db/schema.js';

const spawnedChildren: ChildProcess[] = [];

afterEach(() => {
  while (spawnedChildren.length > 0) {
    const child = spawnedChildren.pop();
    if (child === undefined || child.pid === undefined) {
      continue;
    }
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      /* already exited */
    }
  }
});

const SLEEP_PROGRAM = 'setTimeout(() => {}, 60_000);';

const recordingSpawn: AgentCiSpawn = (_command, _args, options: SpawnOptions) => {
  const child = spawn(
    process.execPath,
    [
      '-e',
      SLEEP_PROGRAM,
    ],
    options,
  );
  spawnedChildren.push(child);
  return child;
};

describe('startAgentCiRun', () => {
  test('writes a session row with the spawned child PID', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-agent-ci-launcher-'));
    const opened = openTasksDatabaseAtPath(join(dir, 'tasks.sqlite'));
    try {
      const now = new Date().toISOString();
      opened.db
        .insert(tasks)
        .values({
          id: 'task-launch',
          projectRoot: '/repo',
          worktreePath: '/repo-launch',
          title: 'launch',
          branch: 'launch',
          headSha: null,
          reviewStatus: 'not_started',
          status: 'active',
          source: 'git-worktree',
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
        })
        .run();

      const result = startAgentCiRun({
        db: opened.db,
        taskId: 'task-launch',
        workflow: '.github/workflows/test.yml',
        cwd: dir,
        spawnFn: recordingSpawn,
      });

      expect(result.pid).toBeGreaterThan(0);
      expect(result.sessionId.startsWith('task-launch-')).toBe(true);

      const row = opened.db
        .select()
        .from(taskSessions)
        .where(eq(taskSessions.id, result.sessionId))
        .get();
      expect(row?.pid).toBe(result.pid);
      expect(row?.status).toBe('active');
      expect(row?.kind).toBe('agent_ci_review');
      expect(row?.completedAt).toBeNull();
      expect(row?.title).toBe('agent-ci: test.yml');
    } finally {
      opened.close();
    }
  });

  test('rejects empty workflow argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-agent-ci-launcher-empty-'));
    const opened = openTasksDatabaseAtPath(join(dir, 'tasks.sqlite'));
    try {
      expect(() =>
        startAgentCiRun({
          db: opened.db,
          taskId: 'task-x',
          workflow: '   ',
          cwd: dir,
          spawnFn: recordingSpawn,
        }),
      ).toThrow('workflow path is required');
    } finally {
      opened.close();
    }
  });
});
