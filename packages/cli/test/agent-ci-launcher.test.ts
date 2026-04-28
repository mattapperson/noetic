import { afterEach, describe, expect, test } from 'bun:test';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';

import type {
  AgentCiSpawn,
  StartAgentCiRunArgs,
} from '../src/commands/builtins/tasks/agent-ci-launcher.js';
import {
  AgentCiSpawnError,
  startAgentCiRun,
} from '../src/commands/builtins/tasks/agent-ci-launcher.js';
import { openTasksDatabaseAtPath } from '../src/commands/builtins/tasks/db/index.js';
import { taskSessions, tasks } from '../src/commands/builtins/tasks/db/schema.js';

const spawnedChildren: ChildProcess[] = [];

afterEach(async () => {
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
    await waitDead(child.pid, 1_000);
  }
});

async function waitDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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

interface BaseDbArgs {
  taskId: string;
}

function seedTaskRow(opened: ReturnType<typeof openTasksDatabaseAtPath>, args: BaseDbArgs): void {
  const now = new Date().toISOString();
  opened.db
    .insert(tasks)
    .values({
      id: args.taskId,
      projectRoot: '/repo',
      worktreePath: `/repo-${args.taskId}`,
      title: args.taskId,
      branch: args.taskId,
      headSha: null,
      reviewStatus: 'not_started',
      status: 'active',
      source: 'git-worktree',
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    })
    .run();
}

describe('startAgentCiRun', () => {
  test('writes a session row with the spawned child PID and starttime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-agent-ci-launcher-'));
    const opened = openTasksDatabaseAtPath(join(dir, 'tasks.sqlite'));
    try {
      seedTaskRow(opened, {
        taskId: 'task-launch',
      });

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
      expect(row?.pidStarttime).not.toBeNull();
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

  test('throws AgentCiSpawnError when spawn returns no pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-agent-ci-launcher-nopid-'));
    const opened = openTasksDatabaseAtPath(join(dir, 'tasks.sqlite'));
    try {
      seedTaskRow(opened, {
        taskId: 'task-nopid',
      });
      const noPidSpawn: AgentCiSpawn = () => ({
        pid: undefined,
        unref() {
          /* noop */
        },
        on() {
          return this;
        },
      });
      const args: StartAgentCiRunArgs = {
        db: opened.db,
        taskId: 'task-nopid',
        workflow: 'foo.yml',
        cwd: dir,
        spawnFn: noPidSpawn,
      };
      expect(() => startAgentCiRun(args)).toThrowError(AgentCiSpawnError);
      const row = opened.db
        .select()
        .from(taskSessions)
        .where(eq(taskSessions.taskId, 'task-nopid'))
        .get();
      expect(row).toBeUndefined();
    } finally {
      opened.close();
    }
  });

  test('throws AgentCiSpawnError when child is already dead at insert time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noetic-agent-ci-launcher-dead-'));
    const opened = openTasksDatabaseAtPath(join(dir, 'tasks.sqlite'));
    try {
      seedTaskRow(opened, {
        taskId: 'task-dead',
      });
      const fakeSpawn: AgentCiSpawn = () => ({
        pid: 999_999,
        unref() {
          /* noop */
        },
        on() {
          return this;
        },
      });
      const args: StartAgentCiRunArgs = {
        db: opened.db,
        taskId: 'task-dead',
        workflow: 'foo.yml',
        cwd: dir,
        spawnFn: fakeSpawn,
        signaller: {
          kill() {
            /* noop */
          },
          isAlive() {
            return false;
          },
          startTime() {
            return null;
          },
        },
      };
      expect(() => startAgentCiRun(args)).toThrowError(AgentCiSpawnError);
      const row = opened.db
        .select()
        .from(taskSessions)
        .where(eq(taskSessions.taskId, 'task-dead'))
        .get();
      expect(row).toBeUndefined();
    } finally {
      opened.close();
    }
  });
});
