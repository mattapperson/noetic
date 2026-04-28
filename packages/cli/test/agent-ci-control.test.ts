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
  target: number;
  signal: ControlSignal;
}

interface MockOpts {
  alivePids?: Set<number>;
  startTimes?: Map<number, string>;
  killBehaviour?: Map<ControlSignal, NodeJS.ErrnoException | Error>;
}

function makeMockSignaller(opts: MockOpts = {}): {
  signaller: Signaller;
  signals: RecordedSignal[];
} {
  const signals: RecordedSignal[] = [];
  const alive = opts.alivePids ?? new Set<number>();
  const startTimes = opts.startTimes ?? new Map<number, string>();
  const killBehaviour =
    opts.killBehaviour ?? new Map<ControlSignal, NodeJS.ErrnoException | Error>();
  return {
    signaller: {
      kill(target, signal) {
        signals.push({
          target,
          signal,
        });
        const err = killBehaviour.get(signal);
        if (err !== undefined) {
          throw err;
        }
      },
      isAlive(pid) {
        return alive.has(pid);
      },
      startTime(pid) {
        return startTimes.get(pid) ?? null;
      },
    },
    signals,
  };
}

function fresh(): ReturnType<typeof freshTasksDb> {
  return freshTasksDb('noetic-agent-ci-control-');
}

function makeErrno(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), {
    code,
  });
}

function makeEsrch(): NodeJS.ErrnoException {
  return makeErrno('ESRCH', 'No such process');
}

const STARTTIME_A = 'Fri Apr 25 10:00:00 2026';
const STARTTIME_B = 'Fri Apr 25 10:00:01 2026';

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
  test('sends SIGTERM to process group and marks cancelled', () => {
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
        pidStarttime: STARTTIME_A,
      });
      const { signaller, signals } = makeMockSignaller({
        alivePids: new Set([
          4242,
        ]),
        startTimes: new Map([
          [
            4242,
            STARTTIME_A,
          ],
        ]),
      });
      const result: AgentCiActionResult = cancelAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('cancelled');
      expect(signals).toEqual([
        {
          target: -4242,
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
        pidStarttime: STARTTIME_A,
      });
      const { signaller, signals } = makeMockSignaller({
        alivePids: new Set([
          4243,
        ]),
        startTimes: new Map([
          [
            4243,
            STARTTIME_A,
          ],
        ]),
      });
      cancelAgentCiRun(opened.db, 'task-1', signaller);
      expect(signals.map((s) => s.signal)).toEqual([
        'SIGCONT',
        'SIGTERM',
      ]);
      expect(signals.map((s) => s.target)).toEqual([
        -4243,
        -4243,
      ]);
    } finally {
      opened.close();
    }
  });

  test('SIGTERM ESRCH still marks session (status=failed) — DB and process stay in sync', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'sess-race',
        pid: 4244,
        pidStarttime: STARTTIME_A,
      });
      const { signaller } = makeMockSignaller({
        alivePids: new Set([
          4244,
        ]),
        startTimes: new Map([
          [
            4244,
            STARTTIME_A,
          ],
        ]),
        killBehaviour: new Map([
          [
            'SIGTERM',
            makeEsrch(),
          ],
        ]),
      });
      const result = cancelAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('stale_process');
      const row = opened.db
        .select()
        .from(taskSessions)
        .where(eq(taskSessions.id, 'sess-race'))
        .get();
      expect(row?.status).toBe('failed');
      expect(row?.completedAt).not.toBeNull();
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

  test('returns stale_process when starttime mismatch (PID reuse) and does not signal', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'sess-reused',
        pid: 4245,
        pidStarttime: STARTTIME_A,
      });
      const { signaller, signals } = makeMockSignaller({
        alivePids: new Set([
          4245,
        ]),
        startTimes: new Map([
          [
            4245,
            STARTTIME_B,
          ],
        ]),
      });
      const result = cancelAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('stale_process');
      expect(signals).toEqual([]);
      const row = opened.db
        .select()
        .from(taskSessions)
        .where(eq(taskSessions.id, 'sess-reused'))
        .get();
      expect(row?.status).toBe('failed');
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
        pidStarttime: STARTTIME_A,
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
  test('writes pausedAt before SIGSTOP and signals process group', () => {
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
        pidStarttime: STARTTIME_A,
      });
      const { signaller, signals } = makeMockSignaller({
        alivePids: new Set([
          5151,
        ]),
        startTimes: new Map([
          [
            5151,
            STARTTIME_A,
          ],
        ]),
      });
      const result = togglePauseAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('paused');
      expect(signals).toEqual([
        {
          target: -5151,
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

  test('rolls back pausedAt when SIGSTOP throws unexpectedly', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'sess-stopfail',
        pid: 5161,
        pidStarttime: STARTTIME_A,
      });
      const epermErr = makeErrno('EPERM', 'not permitted');
      const { signaller } = makeMockSignaller({
        alivePids: new Set([
          5161,
        ]),
        startTimes: new Map([
          [
            5161,
            STARTTIME_A,
          ],
        ]),
        killBehaviour: new Map([
          [
            'SIGSTOP',
            epermErr,
          ],
        ]),
      });
      expect(() => togglePauseAgentCiRun(opened.db, 'task-1', signaller)).toThrow('not permitted');
      const row = opened.db
        .select()
        .from(taskSessions)
        .where(eq(taskSessions.id, 'sess-stopfail'))
        .get();
      expect(row?.pausedAt).toBeNull();
    } finally {
      opened.close();
    }
  });

  test('clears pausedAt before SIGCONT and rolls back on signal failure', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'sess-resume-fail',
        pid: 5162,
        pausedAt: '2026-01-01T00:00:00.000Z',
        pidStarttime: STARTTIME_A,
      });
      const epermErr = makeErrno('EPERM', 'not permitted');
      const { signaller } = makeMockSignaller({
        alivePids: new Set([
          5162,
        ]),
        startTimes: new Map([
          [
            5162,
            STARTTIME_A,
          ],
        ]),
        killBehaviour: new Map([
          [
            'SIGCONT',
            epermErr,
          ],
        ]),
      });
      expect(() => togglePauseAgentCiRun(opened.db, 'task-1', signaller)).toThrow('not permitted');
      const row = opened.db
        .select()
        .from(taskSessions)
        .where(eq(taskSessions.id, 'sess-resume-fail'))
        .get();
      expect(row?.pausedAt).toBe('2026-01-01T00:00:00.000Z');
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
        pidStarttime: STARTTIME_A,
      });
      const { signaller, signals } = makeMockSignaller({
        alivePids: new Set([
          5252,
        ]),
        startTimes: new Map([
          [
            5252,
            STARTTIME_A,
          ],
        ]),
      });
      const result = togglePauseAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('resumed');
      expect(signals).toEqual([
        {
          target: -5252,
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
        pidStarttime: STARTTIME_A,
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

  test('returns stale_process when starttime mismatches', () => {
    const opened = fresh();
    try {
      seedTask({
        opened,
        taskId: 'task-1',
      });
      seedAgentCiSession({
        opened,
        taskId: 'task-1',
        sessionId: 'sess-reused-pause',
        pid: 6262,
        pidStarttime: STARTTIME_A,
      });
      const { signaller, signals } = makeMockSignaller({
        alivePids: new Set([
          6262,
        ]),
        startTimes: new Map([
          [
            6262,
            STARTTIME_B,
          ],
        ]),
      });
      const result = togglePauseAgentCiRun(opened.db, 'task-1', signaller);
      expect(result.kind).toBe('stale_process');
      expect(signals).toEqual([]);
    } finally {
      opened.close();
    }
  });
});
