import { describe, expect, test } from 'bun:test';

import { eq } from 'drizzle-orm';

import type {
  AgentCiActionResult,
  ControlSignal,
  Signaller,
} from '../src/commands/builtins/tasks/agent-ci-control.js';
import {
  cancelAgentCiRun,
  findActiveAgentCiSession,
  togglePauseAgentCiRun,
} from '../src/commands/builtins/tasks/agent-ci-control.js';
import { taskSessions } from '../src/commands/builtins/tasks/db/schema.js';
import { freshTasksDb, seedAgentCiSession, seedTask } from './_helpers.js';

interface RecordedSignal {
  pid: number;
  signal: ControlSignal;
}

interface MockOpts {
  alivePids?: Set<number>;
}

function makeMockSignaller(opts: MockOpts = {}): {
  signaller: Signaller;
  signals: RecordedSignal[];
} {
  const signals: RecordedSignal[] = [];
  const alive = opts.alivePids ?? new Set<number>();
  return {
    signaller: {
      kill(pid, signal) {
        signals.push({
          pid,
          signal,
        });
      },
      isAlive(pid) {
        return alive.has(pid);
      },
    },
    signals,
  };
}

function fresh(): ReturnType<typeof freshTasksDb> {
  return freshTasksDb('noetic-agent-ci-control-');
}

describe('findActiveAgentCiSession', () => {
  test('returns the newest active agent_ci_review session', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'older',
        pid: 100,
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'newer',
        pid: 101,
        startedAt: '2026-02-01T00:00:00.000Z',
      });
      const found = findActiveAgentCiSession(opened.db, 'task-1');
      expect(found?.id).toBe('newer');
    } finally {
      opened.close();
    }
  });

  test('returns null when no active session exists', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      const found = findActiveAgentCiSession(opened.db, 'task-1');
      expect(found).toBeNull();
    } finally {
      opened.close();
    }
  });
});

describe('cancelAgentCiRun', () => {
  test('sends SIGTERM and marks session cancelled', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'sess-a',
        pid: 4242,
      });
      const { signaller, signals } = makeMockSignaller({
        alivePids: new Set([
          4242,
        ]),
      });
      const result: AgentCiActionResult = cancelAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('cancelled');
      expect(signals).toEqual([
        {
          pid: 4242,
          signal: 'SIGTERM',
        },
      ]);
      const row = opened.db.select().from(taskSessions).where(eq(taskSessions.id, 'sess-a')).get();
      expect(row?.status).toBe('cancelled');
      expect(row?.completedAt).not.toBeNull();
      expect(row?.pausedAt).toBeNull();
    } finally {
      opened.close();
    }
  });

  test('sends SIGCONT before SIGTERM when paused', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'sess-paused',
        pid: 4243,
        pausedAt: '2026-01-01T00:00:00.000Z',
      });
      const { signaller, signals } = makeMockSignaller({
        alivePids: new Set([
          4243,
        ]),
      });
      cancelAgentCiRun(opened.db, 'task-1', signaller);
      expect(signals.map((s) => s.signal)).toEqual([
        'SIGCONT',
        'SIGTERM',
      ]);
    } finally {
      opened.close();
    }
  });

  test('returns no_active_run when no agent-ci session exists', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      const { signaller, signals } = makeMockSignaller();
      const result = cancelAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('no_active_run');
      expect(signals).toEqual([]);
    } finally {
      opened.close();
    }
  });

  test('returns pid_unavailable when session has no pid', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'sess-no-pid',
        pid: null,
      });
      const { signaller, signals } = makeMockSignaller();
      const result = cancelAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('pid_unavailable');
      expect(signals).toEqual([]);
    } finally {
      opened.close();
    }
  });

  test('returns stale_process and marks failed when pid is dead', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'sess-dead',
        pid: 9999,
      });
      const { signaller, signals } = makeMockSignaller();
      const result = cancelAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('stale_process');
      expect(signals).toEqual([]);
      const row = opened.db
        .select()
        .from(taskSessions)
        .where(eq(taskSessions.id, 'sess-dead'))
        .get();
      expect(row?.status).toBe('failed');
      expect(row?.completedAt).not.toBeNull();
    } finally {
      opened.close();
    }
  });
});

describe('togglePauseAgentCiRun', () => {
  test('sends SIGSTOP, sets pausedAt, returns paused', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'sess-run',
        pid: 5151,
      });
      const { signaller, signals } = makeMockSignaller({
        alivePids: new Set([
          5151,
        ]),
      });
      const result = togglePauseAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('paused');
      expect(signals).toEqual([
        {
          pid: 5151,
          signal: 'SIGSTOP',
        },
      ]);
      const row = opened.db
        .select()
        .from(taskSessions)
        .where(eq(taskSessions.id, 'sess-run'))
        .get();
      expect(row?.pausedAt).not.toBeNull();
      expect(row?.status).toBe('active');
    } finally {
      opened.close();
    }
  });

  test('sends SIGCONT, clears pausedAt, returns resumed', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'sess-paused',
        pid: 5252,
        pausedAt: '2026-01-01T00:00:00.000Z',
      });
      const { signaller, signals } = makeMockSignaller({
        alivePids: new Set([
          5252,
        ]),
      });
      const result = togglePauseAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('resumed');
      expect(signals).toEqual([
        {
          pid: 5252,
          signal: 'SIGCONT',
        },
      ]);
      const row = opened.db
        .select()
        .from(taskSessions)
        .where(eq(taskSessions.id, 'sess-paused'))
        .get();
      expect(row?.pausedAt).toBeNull();
    } finally {
      opened.close();
    }
  });

  test('returns stale_process when pid is dead', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'sess-dead',
        pid: 9999,
      });
      const { signaller, signals } = makeMockSignaller();
      const result = togglePauseAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('stale_process');
      expect(signals).toEqual([]);
      const row = opened.db
        .select()
        .from(taskSessions)
        .where(eq(taskSessions.id, 'sess-dead'))
        .get();
      expect(row?.status).toBe('failed');
    } finally {
      opened.close();
    }
  });

  test('returns pid_unavailable when session has no pid', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'sess-no-pid',
        pid: null,
      });
      const { signaller, signals } = makeMockSignaller();
      const result = togglePauseAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('pid_unavailable');
      expect(signals).toEqual([]);
    } finally {
      opened.close();
    }
  });

  test('returns no_active_run when no agent-ci session exists', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      const { signaller, signals } = makeMockSignaller();
      const result = togglePauseAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('no_active_run');
      expect(signals).toEqual([]);
    } finally {
      opened.close();
    }
  });
});
