import { execFileSync } from 'node:child_process';

import { and, desc, eq, isNull } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import type * as schema from './db/schema.js';
import type { TaskSessionRecord, TaskSessionStatus } from './db/schema.js';
import { AGENT_CI_REVIEW_KIND, taskSessions } from './db/schema.js';

//#region Types

type TasksDb = BunSQLiteDatabase<typeof schema>;

export type ControlSignal = 'SIGTERM' | 'SIGSTOP' | 'SIGCONT';

export interface Signaller {
  // Caller passes the negative process-group id (with detached spawn, pgid === pid)
  // to signal the whole tree. Pass a positive pid only for direct control.
  kill(target: number, signal: ControlSignal): void;
  isAlive(pid: number): boolean;
  startTime(pid: number): string | null;
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
  groupTarget: number;
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

function readPidStartTime(pid: number): string | null {
  try {
    const out = execFileSync(
      'ps',
      [
        '-p',
        String(pid),
        '-o',
        'lstart=',
      ],
      {
        stdio: [
          'ignore',
          'pipe',
          'ignore',
        ],
        encoding: 'utf8',
      },
    ).trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}

export const defaultSignaller: Signaller = {
  kill(target: number, signal: ControlSignal): void {
    process.kill(target, signal);
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
  startTime(pid: number): string | null {
    return readPidStartTime(pid);
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
        eq(taskSessions.kind, AGENT_CI_REVIEW_KIND),
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

//#region Signal Helpers

interface KillOutcome {
  ok: boolean;
  alreadyDead: boolean;
}

function tryKill(signaller: Signaller, target: number, signal: ControlSignal): KillOutcome {
  try {
    signaller.kill(target, signal);
    return {
      ok: true,
      alreadyDead: false,
    };
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ESRCH') {
      return {
        ok: false,
        alreadyDead: true,
      };
    }
    throw err;
  }
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
  if (!verifyPidIdentity(signaller, pid, session.pidStarttime)) {
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
      groupTarget: -pid,
      now,
    },
  };
}

function verifyPidIdentity(
  signaller: Signaller,
  pid: number,
  storedStartTime: string | null,
): boolean {
  if (!signaller.isAlive(pid)) {
    return false;
  }
  if (storedStartTime === null) {
    // Legacy row without recorded start time — fall back to liveness only.
    return true;
  }
  const current = signaller.startTime(pid);
  if (current === null) {
    return false;
  }
  return current === storedStartTime;
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
  const { session, pid, groupTarget, now } = outcome.ready;
  if (session.pausedAt !== null) {
    tryKill(signaller, groupTarget, 'SIGCONT');
  }
  const term = tryKill(signaller, groupTarget, 'SIGTERM');
  markCompleted({
    db,
    sessionId: session.id,
    status: term.alreadyDead ? 'failed' : 'cancelled',
    now,
  });
  if (term.alreadyDead) {
    return {
      kind: 'stale_process',
      sessionId: session.id,
      pid,
    };
  }
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
  const { session, pid, groupTarget, now } = outcome.ready;
  if (session.pausedAt === null) {
    return doPause({
      db,
      session,
      pid,
      groupTarget,
      now,
      signaller,
    });
  }
  return doResume({
    db,
    session,
    pid,
    groupTarget,
    now,
    signaller,
  });
}

interface ToggleArgs {
  db: TasksDb;
  session: TaskSessionRecord;
  pid: number;
  groupTarget: number;
  now: string;
  signaller: Signaller;
}

function doPause(args: ToggleArgs): AgentCiActionResult {
  // Write DB first so a signal failure can be undone without leaving an
  // inconsistent (process-stopped, DB-says-running) state.
  setPausedAt({
    db: args.db,
    sessionId: args.session.id,
    pausedAt: args.now,
    now: args.now,
  });
  try {
    args.signaller.kill(args.groupTarget, 'SIGSTOP');
  } catch (err) {
    setPausedAt({
      db: args.db,
      sessionId: args.session.id,
      pausedAt: null,
      now: new Date().toISOString(),
    });
    throw err;
  }
  return {
    kind: 'paused',
    sessionId: args.session.id,
    pid: args.pid,
  };
}

function doResume(args: ToggleArgs): AgentCiActionResult {
  const previousPausedAt = args.session.pausedAt;
  setPausedAt({
    db: args.db,
    sessionId: args.session.id,
    pausedAt: null,
    now: args.now,
  });
  try {
    args.signaller.kill(args.groupTarget, 'SIGCONT');
  } catch (err) {
    setPausedAt({
      db: args.db,
      sessionId: args.session.id,
      pausedAt: previousPausedAt,
      now: new Date().toISOString(),
    });
    throw err;
  }
  return {
    kind: 'resumed',
    sessionId: args.session.id,
    pid: args.pid,
  };
}

//#endregion
