import { describe, expect, test } from 'bun:test';
import type { SpawnOptions } from 'node:child_process';
import type { Task } from '@noetic-tools/code-agent/tasks/schema';
import {
  AutopilotState,
  EventKind,
  generateTaskId,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic-tools/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic-tools/code-agent/tasks/store/fs-node';
import { saveTask, tailEvents, taskDirPaths } from '@noetic-tools/code-agent/tasks/store/fs-node';
import type { Signaller } from '../../src/tasks/runtime/agent-ci-control.js';
import type {
  AgentCiSpawn,
  StartAgentCiRunArgs,
} from '../../src/tasks/runtime/agent-ci-launcher.js';
import { AgentCiSpawnError, startAgentCiRun } from '../../src/tasks/runtime/agent-ci-launcher.js';
import { loadRunner, saveRunner } from '../../src/tasks/runtime/runner-state.js';
import { makeStoreContext } from './_helpers.js';

//#region Helpers

const NOW = '2026-04-30T00:00:00.000Z';
const STARTTIME_A = 'Fri Apr 25 10:00:00 2026';

function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? generateTaskId();
  return {
    id,
    source: TaskSource.Worktree,
    title: 'Test task',
    projectRoot: '/repo',
    worktreePath: '/repo/wt',
    branch: 'feature',
    headSha: null,
    reviewStatus: TaskReviewStatus.NotStarted,
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

interface RecordedSpawn {
  command: string;
  args: ReadonlyArray<string>;
  options: SpawnOptions;
}

interface MockSpawnArgs {
  /** Records every spawn invocation. */
  spawns: RecordedSpawn[];
  /** Pid handed back from `spawn` (defaults to 4242). */
  pid?: number | undefined;
  /** Triggered asynchronously on the child via `error` event. */
  errorOnSpawn?: Error;
}

function makeMockSpawn(args: MockSpawnArgs): AgentCiSpawn {
  return (command, spawnArgs, options) => {
    args.spawns.push({
      command,
      args: spawnArgs,
      options,
    });
    const pid = 'pid' in args ? args.pid : 4242;
    const child = {
      pid,
      unref(): void {
        /* noop */
      },
      on(event: 'error', listener: (err: Error) => void): unknown {
        const err = args.errorOnSpawn;
        if (event === 'error' && err !== undefined) {
          // Fire on next tick so the launcher attaches before it lands.
          queueMicrotask(() => {
            listener(err);
          });
        }
        return this;
      },
    };
    return child;
  };
}

interface MockSignallerOpts {
  alivePids?: Set<number>;
  startTimes?: Map<number, string>;
}

function makeMockSignaller(opts: MockSignallerOpts = {}): {
  signaller: Signaller;
  killed: Array<{
    target: number;
    signal: string;
  }>;
} {
  const killed: Array<{
    target: number;
    signal: string;
  }> = [];
  const alive = opts.alivePids ?? new Set<number>();
  const startTimes = opts.startTimes ?? new Map<number, string>();
  return {
    signaller: {
      kill(target, signal): void {
        killed.push({
          target,
          signal,
        });
      },
      isAlive(pid): boolean {
        return alive.has(pid);
      },
      startTime(pid): string | null {
        return startTimes.get(pid) ?? null;
      },
    },
    killed,
  };
}

interface SeededCtx {
  ctx: TaskStoreContext;
  task: Task;
  taskDir: string;
}

async function seed(
  reviewStatus: TaskReviewStatus = TaskReviewStatus.NotStarted,
): Promise<SeededCtx> {
  const ctx = makeStoreContext('/repo');
  const task = makeTask({
    reviewStatus,
  });
  await saveTask(ctx, task);
  const dir = taskDirPaths(ctx, task.id).dir;
  return {
    ctx,
    task,
    taskDir: dir,
  };
}

const RUNNER_SCRIPT = '/fake/agent-ci-runner.ts';

//#endregion

//#region Happy path

describe('startAgentCiRun (happy path)', () => {
  test('writes _runner.json, flips reviewStatus to reviewing, emits event', async () => {
    const seeded = await seed();
    const spawns: RecordedSpawn[] = [];
    const { signaller } = makeMockSignaller({
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

    const result = await startAgentCiRun({
      ctx: seeded.ctx,
      taskId: seeded.task.id,
      workflow: '.github/workflows/test.yml',
      cwd: '/repo/wt',
      spawnFn: makeMockSpawn({
        spawns,
      }),
      signaller,
      now: NOW,
      runnerScript: RUNNER_SCRIPT,
    });

    expect(result.pid).toBe(4242);
    expect(result.taskId).toBe(seeded.task.id);
    expect(result.previousReviewStatus).toBe(TaskReviewStatus.NotStarted);
    expect(result.reviewStatus).toBe(TaskReviewStatus.Reviewing);
    expect(result.workflow).toBe('.github/workflows/test.yml');
    expect(result.sessionId.startsWith(`${seeded.task.id}-`)).toBe(true);

    // _runner.json round-trips with the captured pid + starttime.
    const runner = await loadRunner(seeded.ctx, seeded.task.id);
    expect(runner).not.toBeNull();
    expect(runner?.pid).toBe(4242);
    expect(runner?.pidStarttime).toBe(STARTTIME_A);
    expect(runner?.sessionId).toBe(result.sessionId);
    expect(runner?.workflow).toBe('.github/workflows/test.yml');
    expect(runner?.pausedAt).toBeNull();

    // Spawn invoked with `bun run <runner>` and NOETIC_TASK_* env.
    expect(spawns).toHaveLength(1);
    const recorded = spawns[0];
    expect(recorded?.command).toBe('bun');
    expect(recorded?.args).toEqual([
      'run',
      RUNNER_SCRIPT,
    ]);
    expect(recorded?.options.cwd).toBe('/repo/wt');
    expect(recorded?.options.detached).toBe(true);
    expect(recorded?.options.env?.NOETIC_TASK_DIR).toBe(seeded.taskDir);
    expect(recorded?.options.env?.NOETIC_TASK_WORKFLOW).toBe('.github/workflows/test.yml');
    expect(recorded?.options.env?.NOETIC_TASK_CWD).toBe('/repo/wt');

    // Durable event landed.
    const events = await tailEvents(seeded.ctx);
    const reviewChange = events.find((e) => e.kind === EventKind.TaskReviewStatusChanged);
    expect(reviewChange).toBeDefined();
    expect(reviewChange?.payload?.previousReviewStatus).toBe(TaskReviewStatus.NotStarted);
    expect(reviewChange?.payload?.reviewStatus).toBe(TaskReviewStatus.Reviewing);
    expect(reviewChange?.payload?.phase).toBe('spawn');
  });

  test('keeps approved status terminal across re-spawn', async () => {
    const seeded = await seed(TaskReviewStatus.Approved);
    const { signaller } = makeMockSignaller({
      alivePids: new Set([
        4242,
      ]),
    });
    const result = await startAgentCiRun({
      ctx: seeded.ctx,
      taskId: seeded.task.id,
      workflow: 'foo.yml',
      cwd: '/repo/wt',
      spawnFn: makeMockSpawn({
        spawns: [],
      }),
      signaller,
      now: NOW,
      runnerScript: RUNNER_SCRIPT,
    });
    expect(result.previousReviewStatus).toBe(TaskReviewStatus.Approved);
    expect(result.reviewStatus).toBe(TaskReviewStatus.Approved);
  });
});

//#endregion

//#region Idempotency

describe('startAgentCiRun (idempotency)', () => {
  test('rejects re-spawn when a live runner is already attached', async () => {
    const seeded = await seed();
    // Prime an existing _runner.json that points at a "live" pid.
    await saveRunner(seeded.ctx, {
      taskId: seeded.task.id,
      sessionId: `${seeded.task.id}-existing`,
      pid: 4242,
      pidStarttime: STARTTIME_A,
      workflow: 'foo.yml',
      startedAt: NOW,
      pausedAt: null,
    });
    const { signaller } = makeMockSignaller({
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
    const spawns: RecordedSpawn[] = [];
    await expect(
      startAgentCiRun({
        ctx: seeded.ctx,
        taskId: seeded.task.id,
        workflow: 'foo.yml',
        cwd: '/repo/wt',
        spawnFn: makeMockSpawn({
          spawns,
        }),
        signaller,
        now: NOW,
        runnerScript: RUNNER_SCRIPT,
      }),
    ).rejects.toBeInstanceOf(AgentCiSpawnError);
    expect(spawns).toHaveLength(0);
  });

  test('overwrites a stale runner sidecar (recorded pid is dead)', async () => {
    const seeded = await seed();
    await saveRunner(seeded.ctx, {
      taskId: seeded.task.id,
      sessionId: `${seeded.task.id}-stale`,
      pid: 9999,
      pidStarttime: STARTTIME_A,
      workflow: 'foo.yml',
      startedAt: NOW,
      pausedAt: null,
    });
    const { signaller } = makeMockSignaller({
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
    const result = await startAgentCiRun({
      ctx: seeded.ctx,
      taskId: seeded.task.id,
      workflow: 'foo.yml',
      cwd: '/repo/wt',
      spawnFn: makeMockSpawn({
        spawns: [],
      }),
      signaller,
      now: NOW,
      runnerScript: RUNNER_SCRIPT,
    });
    expect(result.pid).toBe(4242);
    const runner = await loadRunner(seeded.ctx, seeded.task.id);
    expect(runner?.pid).toBe(4242);
    expect(runner?.sessionId).toBe(result.sessionId);
  });
});

//#endregion

//#region Error paths

describe('startAgentCiRun (errors)', () => {
  test('rejects empty workflow argument', async () => {
    const seeded = await seed();
    const args: StartAgentCiRunArgs = {
      ctx: seeded.ctx,
      taskId: seeded.task.id,
      workflow: '   ',
      cwd: '/repo/wt',
      spawnFn: makeMockSpawn({
        spawns: [],
      }),
      runnerScript: RUNNER_SCRIPT,
    };
    await expect(startAgentCiRun(args)).rejects.toThrow('workflow path is required');
  });

  test('throws AgentCiSpawnError when spawn returns no pid', async () => {
    const seeded = await seed();
    const { signaller } = makeMockSignaller();
    await expect(
      startAgentCiRun({
        ctx: seeded.ctx,
        taskId: seeded.task.id,
        workflow: 'foo.yml',
        cwd: '/repo/wt',
        spawnFn: makeMockSpawn({
          spawns: [],
          pid: undefined,
        }),
        signaller,
        runnerScript: RUNNER_SCRIPT,
      }),
    ).rejects.toBeInstanceOf(AgentCiSpawnError);
    // No sidecar should have been written.
    const runner = await loadRunner(seeded.ctx, seeded.task.id);
    expect(runner).toBeNull();
  });

  test('throws AgentCiSpawnError when child reports dead at insert time', async () => {
    const seeded = await seed();
    // signaller marks the pid as dead.
    const { signaller } = makeMockSignaller({
      alivePids: new Set(),
    });
    await expect(
      startAgentCiRun({
        ctx: seeded.ctx,
        taskId: seeded.task.id,
        workflow: 'foo.yml',
        cwd: '/repo/wt',
        spawnFn: makeMockSpawn({
          spawns: [],
          pid: 4242,
        }),
        signaller,
        runnerScript: RUNNER_SCRIPT,
      }),
    ).rejects.toBeInstanceOf(AgentCiSpawnError);
    const runner = await loadRunner(seeded.ctx, seeded.task.id);
    expect(runner).toBeNull();
  });

  test('rejects when the task does not exist on disk', async () => {
    const ctx = makeStoreContext('/repo');
    const { signaller } = makeMockSignaller({
      alivePids: new Set([
        4242,
      ]),
    });
    await expect(
      startAgentCiRun({
        ctx,
        taskId: generateTaskId(),
        workflow: 'foo.yml',
        cwd: '/repo/wt',
        spawnFn: makeMockSpawn({
          spawns: [],
        }),
        signaller,
        runnerScript: RUNNER_SCRIPT,
      }),
    ).rejects.toThrow(/not found/);
  });
});

//#endregion
