import { describe, expect, test } from 'bun:test';
import type { Task } from '@noetic/code-agent/tasks/schema';
import {
  AutopilotState,
  generateTaskId,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { loadTask, saveTask } from '@noetic/code-agent/tasks/store/fs-node';
import type {
  AgentCiActionResult,
  ControlSignal,
  Signaller,
} from '../src/tasks/runtime/agent-ci-control.js';
import {
  cancelAgentCiRun,
  findActiveAgentCiRunner,
  togglePauseAgentCiRun,
} from '../src/tasks/runtime/agent-ci-control.js';
import { loadRunner, saveRunner } from '../src/tasks/runtime/runner-state.js';
import { makeStoreContext } from './tasks/_helpers.js';

//#region Mock helpers

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
const NOW = '2026-04-30T00:00:00.000Z';

//#endregion

//#region Seeding

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    source: TaskSource.Worktree,
    title: id,
    projectRoot: '/repo',
    worktreePath: `/repo-${id}`,
    branch: id,
    headSha: null,
    reviewStatus: TaskReviewStatus.Reviewing,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: false,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

interface SeedArgs {
  pid: number | null;
  pausedAt?: string | null;
  pidStarttime?: string | null;
  reviewStatus?: TaskReviewStatus;
  sessionId?: string;
}

interface SeedResult {
  ctx: TaskStoreContext;
  taskId: string;
  sessionId: string;
}

async function seed(args: SeedArgs): Promise<SeedResult> {
  const ctx = makeStoreContext('/repo');
  const taskId = generateTaskId();
  const sessionId = args.sessionId ?? `${taskId}-sess`;
  await saveTask(
    ctx,
    makeTask(taskId, {
      reviewStatus: args.reviewStatus ?? TaskReviewStatus.Reviewing,
    }),
  );
  if (args.pid !== null) {
    await saveRunner(ctx, {
      taskId,
      sessionId,
      pid: args.pid,
      pidStarttime: args.pidStarttime ?? null,
      workflow: 'foo.yml',
      startedAt: NOW,
      pausedAt: args.pausedAt ?? null,
    });
  }
  return {
    ctx,
    taskId,
    sessionId,
  };
}

//#endregion

//#region findActiveAgentCiRunner

describe('findActiveAgentCiRunner', () => {
  test('returns the runner sidecar when present', async () => {
    const seeded = await seed({
      pid: 100,
      pidStarttime: STARTTIME_A,
    });
    const runner = await findActiveAgentCiRunner(seeded.ctx, seeded.taskId);
    expect(runner?.pid).toBe(100);
    expect(runner?.sessionId).toBe(seeded.sessionId);
  });

  test('returns null when no runner is recorded', async () => {
    const ctx = makeStoreContext('/repo');
    const taskId = generateTaskId();
    await saveTask(ctx, makeTask(taskId));
    const runner = await findActiveAgentCiRunner(ctx, taskId);
    expect(runner).toBeNull();
  });
});

//#endregion

//#region cancelAgentCiRun

describe('cancelAgentCiRun', () => {
  test('SIGTERM the process group, clears sidecar, returns cancelled', async () => {
    const seeded = await seed({
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
    const result: AgentCiActionResult = await cancelAgentCiRun(
      seeded.ctx,
      seeded.taskId,
      signaller,
    );
    expect(result.kind).toBe('cancelled');
    expect(signals).toEqual([
      {
        target: -4242,
        signal: 'SIGTERM',
      },
    ]);
    const runner = await loadRunner(seeded.ctx, seeded.taskId);
    expect(runner).toBeNull();
  });

  test('sends SIGCONT before SIGTERM when paused', async () => {
    const seeded = await seed({
      pid: 4243,
      pidStarttime: STARTTIME_A,
      pausedAt: '2026-01-01T00:00:00.000Z',
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
    await cancelAgentCiRun(seeded.ctx, seeded.taskId, signaller);
    expect(signals.map((s) => s.signal)).toEqual([
      'SIGCONT',
      'SIGTERM',
    ]);
    expect(signals.map((s) => s.target)).toEqual([
      -4243,
      -4243,
    ]);
  });

  test('SIGTERM ESRCH still clears sidecar and reports stale_process', async () => {
    const seeded = await seed({
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
    const result = await cancelAgentCiRun(seeded.ctx, seeded.taskId, signaller);
    expect(result.kind).toBe('stale_process');
    const runner = await loadRunner(seeded.ctx, seeded.taskId);
    expect(runner).toBeNull();
  });

  test('returns no_active_run when no runner sidecar exists', async () => {
    const ctx = makeStoreContext('/repo');
    const taskId = generateTaskId();
    await saveTask(ctx, makeTask(taskId));
    const { signaller, signals } = makeMockSignaller();
    const result = await cancelAgentCiRun(ctx, taskId, signaller);
    expect(result.kind).toBe('no_active_run');
    expect(signals).toEqual([]);
  });

  test('starttime mismatch (PID reuse) returns stale_process and bounces task', async () => {
    const seeded = await seed({
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
    const result = await cancelAgentCiRun(seeded.ctx, seeded.taskId, signaller);
    expect(result.kind).toBe('stale_process');
    expect(signals).toEqual([]);
    const reloaded = await loadTask(seeded.ctx, seeded.taskId);
    expect(reloaded.reviewStatus).toBe(TaskReviewStatus.NeedsChanges);
    const runner = await loadRunner(seeded.ctx, seeded.taskId);
    expect(runner).toBeNull();
  });

  test('returns stale_process when pid is dead', async () => {
    const seeded = await seed({
      pid: 9999,
      pidStarttime: STARTTIME_A,
    });
    const { signaller, signals } = makeMockSignaller();
    const result = await cancelAgentCiRun(seeded.ctx, seeded.taskId, signaller);
    expect(result.kind).toBe('stale_process');
    expect(signals).toEqual([]);
    const runner = await loadRunner(seeded.ctx, seeded.taskId);
    expect(runner).toBeNull();
  });
});

//#endregion

//#region togglePauseAgentCiRun

describe('togglePauseAgentCiRun', () => {
  test('writes pausedAt before SIGSTOP and signals process group', async () => {
    const seeded = await seed({
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
    const result = await togglePauseAgentCiRun(seeded.ctx, seeded.taskId, signaller);
    expect(result.kind).toBe('paused');
    expect(signals).toEqual([
      {
        target: -5151,
        signal: 'SIGSTOP',
      },
    ]);
    const runner = await loadRunner(seeded.ctx, seeded.taskId);
    expect(runner?.pausedAt).not.toBeNull();
  });

  test('rolls back pausedAt when SIGSTOP throws unexpectedly', async () => {
    const seeded = await seed({
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
    await expect(togglePauseAgentCiRun(seeded.ctx, seeded.taskId, signaller)).rejects.toThrow(
      'not permitted',
    );
    const runner = await loadRunner(seeded.ctx, seeded.taskId);
    expect(runner?.pausedAt).toBeNull();
  });

  test('clears pausedAt before SIGCONT and rolls back on signal failure', async () => {
    const seeded = await seed({
      pid: 5162,
      pidStarttime: STARTTIME_A,
      pausedAt: '2026-01-01T00:00:00.000Z',
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
    await expect(togglePauseAgentCiRun(seeded.ctx, seeded.taskId, signaller)).rejects.toThrow(
      'not permitted',
    );
    const runner = await loadRunner(seeded.ctx, seeded.taskId);
    expect(runner?.pausedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('sends SIGCONT, clears pausedAt, returns resumed', async () => {
    const seeded = await seed({
      pid: 5252,
      pidStarttime: STARTTIME_A,
      pausedAt: '2026-01-01T00:00:00.000Z',
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
    const result = await togglePauseAgentCiRun(seeded.ctx, seeded.taskId, signaller);
    expect(result.kind).toBe('resumed');
    expect(signals).toEqual([
      {
        target: -5252,
        signal: 'SIGCONT',
      },
    ]);
    const runner = await loadRunner(seeded.ctx, seeded.taskId);
    expect(runner?.pausedAt).toBeNull();
  });

  test('returns stale_process when pid is dead', async () => {
    const seeded = await seed({
      pid: 9999,
      pidStarttime: STARTTIME_A,
    });
    const { signaller, signals } = makeMockSignaller();
    const result = await togglePauseAgentCiRun(seeded.ctx, seeded.taskId, signaller);
    expect(result.kind).toBe('stale_process');
    expect(signals).toEqual([]);
    const runner = await loadRunner(seeded.ctx, seeded.taskId);
    expect(runner).toBeNull();
  });

  test('returns no_active_run when no runner sidecar exists', async () => {
    const ctx = makeStoreContext('/repo');
    const taskId = generateTaskId();
    await saveTask(ctx, makeTask(taskId));
    const { signaller, signals } = makeMockSignaller();
    const result = await togglePauseAgentCiRun(ctx, taskId, signaller);
    expect(result.kind).toBe('no_active_run');
    expect(signals).toEqual([]);
  });

  test('starttime mismatch returns stale_process and does not signal', async () => {
    const seeded = await seed({
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
    const result = await togglePauseAgentCiRun(seeded.ctx, seeded.taskId, signaller);
    expect(result.kind).toBe('stale_process');
    expect(signals).toEqual([]);
  });
});

//#endregion
