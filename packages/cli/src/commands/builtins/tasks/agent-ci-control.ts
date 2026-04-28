import { and, desc, eq, isNull } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import type * as schema from './db/schema.js';
import type { TaskSessionRecord, TaskSessionStatus } from './db/schema.js';
import { taskSessions } from './db/schema.js';

//#region Types

type TasksDb = BunSQLiteDatabase<typeof schema>;

export type ControlSignal = 'SIGTERM' | 'SIGSTOP' | 'SIGCONT';

export interface Signaller {
  kill(pid: number, signal: ControlSignal): void;
  isAlive(pid: number): boolean;
}

export type AgentCiActionResult =
  | {
      kind: 'cancelled';
      sessionId: string;
      pid: number;
    }
  | {
      kind: 'paused';
      sessionId: string;
      pid: number;
    }
  | {
      kind: 'resumed';
      sessionId: string;
      pid: number;
    }
  | {
      kind: 'no_active_run';
      taskId: string;
    }
  | {
      kind: 'pid_unavailable';
      sessionId: string;
    }
  | {
      kind: 'stale_process';
      sessionId: string;
      pid: number;
    };

interface ResolvedSession {
  session: TaskSessionRecord;
  pid: number;
  now: string;
}

type ResolveOutcome =
  | {
      kind: 'ready';
      ready: ResolvedSession;
    }
  | {
      kind: 'rejected';
      result: AgentCiActionResult;
    };

//#endregion

//#region Default Signaller

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  if (!('code' in err)) {
    return false;
  }
  return typeof err.code === 'string';
}

export const defaultSignaller: Signaller = {
  kill(pid: number, signal: ControlSignal): void {
    process.kill(pid, signal);
  },
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if (isErrnoException(err) && err.code === 'EPERM') {
        return true;
      }
      return false;
    }
  },
};

//#endregion

//#region Queries

export function findActiveAgentCiSession(db: TasksDb, taskId: string): TaskSessionRecord | null {
  const rows = db
    .select()
    .from(taskSessions)
    .where(
      and(
        eq(taskSessions.taskId, taskId),
        eq(taskSessions.kind, 'agent_ci_review'),
        eq(taskSessions.status, 'active'),
        isNull(taskSessions.completedAt),
      ),
    )
    .orderBy(desc(taskSessions.startedAt))
    .limit(1)
    .all();
  return rows[0] ?? null;
}

//#endregion

//#region DB Mutations

interface MarkCompletedArgs {
  db: TasksDb;
  sessionId: string;
  status: Extract<TaskSessionStatus, 'cancelled' | 'failed' | 'completed'>;
  now: string;
}

function markCompleted(args: MarkCompletedArgs): void {
  args.db
    .update(taskSessions)
    .set({
      status: args.status,
      completedAt: args.now,
      pausedAt: null,
      updatedAt: args.now,
    })
    .where(eq(taskSessions.id, args.sessionId))
    .run();
}

interface SetPausedAtArgs {
  db: TasksDb;
  sessionId: string;
  pausedAt: string | null;
  now: string;
}

function setPausedAt(args: SetPausedAtArgs): void {
  args.db
    .update(taskSessions)
    .set({
      pausedAt: args.pausedAt,
      updatedAt: args.now,
    })
    .where(eq(taskSessions.id, args.sessionId))
    .run();
}

//#endregion

//#region Resolution Preamble

const POSIX_AVAILABLE = process.platform !== 'win32';

function resolveActiveSession(db: TasksDb, taskId: string, signaller: Signaller): ResolveOutcome {
  const session = findActiveAgentCiSession(db, taskId);
  if (session === null) {
    return {
      kind: 'rejected',
      result: {
        kind: 'no_active_run',
        taskId,
      },
    };
  }
  if (session.pid === null || !POSIX_AVAILABLE) {
    return {
      kind: 'rejected',
      result: {
        kind: 'pid_unavailable',
        sessionId: session.id,
      },
    };
  }
  const pid = session.pid;
  const now = new Date().toISOString();
  if (!signaller.isAlive(pid)) {
    markCompleted({
      db,
      sessionId: session.id,
      status: 'failed',
      now,
    });
    return {
      kind: 'rejected',
      result: {
        kind: 'stale_process',
        sessionId: session.id,
        pid,
      },
    };
  }
  return {
    kind: 'ready',
    ready: {
      session,
      pid,
      now,
    },
  };
}

//#endregion

//#region Public API

export function cancelAgentCiRun(
  db: TasksDb,
  taskId: string,
  signaller: Signaller = defaultSignaller,
): AgentCiActionResult {
  const outcome = resolveActiveSession(db, taskId, signaller);
  if (outcome.kind === 'rejected') {
    return outcome.result;
  }
  const { session, pid, now } = outcome.ready;
  if (session.pausedAt !== null) {
    signaller.kill(pid, 'SIGCONT');
  }
  signaller.kill(pid, 'SIGTERM');
  markCompleted({
    db,
    sessionId: session.id,
    status: 'cancelled',
    now,
  });
  return {
    kind: 'cancelled',
    sessionId: session.id,
    pid,
  };
}

export function togglePauseAgentCiRun(
  db: TasksDb,
  taskId: string,
  signaller: Signaller = defaultSignaller,
): AgentCiActionResult {
  const outcome = resolveActiveSession(db, taskId, signaller);
  if (outcome.kind === 'rejected') {
    return outcome.result;
  }
  const { session, pid, now } = outcome.ready;
  if (session.pausedAt === null) {
    signaller.kill(pid, 'SIGSTOP');
    setPausedAt({
      db,
      sessionId: session.id,
      pausedAt: now,
      now,
    });
    return {
      kind: 'paused',
      sessionId: session.id,
      pid,
    };
  }
  signaller.kill(pid, 'SIGCONT');
  setPausedAt({
    db,
    sessionId: session.id,
    pausedAt: null,
    now,
  });
  return {
    kind: 'resumed',
    sessionId: session.id,
    pid,
  };
}

//#endregion
