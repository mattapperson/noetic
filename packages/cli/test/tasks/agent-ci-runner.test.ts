import { afterEach, describe, expect, it } from 'bun:test';
import type { SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { RunnerSpawn } from '../../src/commands/builtins/tasks/agent-ci-runner.js';
import { runAgentCi } from '../../src/commands/builtins/tasks/agent-ci-runner.js';
import { taskEvents } from '../../src/commands/builtins/tasks/events.js';
import type { TaskStoreContext } from '../../src/commands/builtins/tasks/fs-store.js';
import {
  loadTask,
  readLog,
  saveTask,
  tailEvents,
} from '../../src/commands/builtins/tasks/fs-store.js';
import { taskDirPaths } from '../../src/commands/builtins/tasks/paths.js';
import { saveRunner } from '../../src/commands/builtins/tasks/runner-state.js';
import type { Event, Task } from '../../src/commands/builtins/tasks/schemas.js';
import {
  AutopilotState,
  EventKind,
  generateTaskId,
  LogEntryKind,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '../../src/commands/builtins/tasks/schemas.js';
import { MemFs, makeStoreContext } from './_helpers.js';

//#region Helpers

const NOW = '2026-04-30T00:00:00.000Z';

function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? generateTaskId();
  return {
    id,
    source: TaskSource.Manual,
    title: 'Test task',
    projectRoot: '/repo',
    worktreePath: null,
    branch: null,
    headSha: null,
    reviewStatus: TaskReviewStatus.Reviewing,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
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

interface FakeChildOptions {
  exitCode: number | null;
  pid?: number;
  /** When set, fire `error` instead of `exit`. */
  errorOnSpawn?: Error;
}

class FakeChild extends EventEmitter {
  readonly pid: number | undefined;

  constructor(opts: FakeChildOptions) {
    super();
    this.pid = opts.pid ?? 12345;
    // Schedule the exit (or error) on the next tick so the runner can
    // attach its listeners before the event fires.
    queueMicrotask(() => {
      if (opts.errorOnSpawn !== undefined) {
        this.emit('error', opts.errorOnSpawn);
        return;
      }
      this.emit('exit', opts.exitCode, null);
    });
  }
}

interface MakeSpawnArgs {
  /** When omitted, defaults to 0; pass `null` to simulate signal-kill. */
  exitCode?: number | null;
  errorOnSpawn?: Error;
  /** Records every spawn invocation. */
  spawns?: Array<{
    command: string;
    args: ReadonlyArray<string>;
    options: SpawnOptions;
  }>;
}

function makeSpawn(args: MakeSpawnArgs = {}): RunnerSpawn {
  return (command, spawnArgs, options) => {
    args.spawns?.push({
      command,
      args: spawnArgs,
      options,
    });
    // Distinguish "not specified" (default 0) from explicit null (kill).
    const exitCode = 'exitCode' in args ? (args.exitCode ?? null) : 0;
    const child = new FakeChild({
      exitCode,
      errorOnSpawn: args.errorOnSpawn,
    });
    return child;
  };
}

interface SeededCtx {
  ctx: TaskStoreContext;
  taskDir: string;
  task: Task;
}

async function seedTaskDir(
  reviewStatus: TaskReviewStatus = TaskReviewStatus.Reviewing,
): Promise<SeededCtx> {
  const ctx = makeStoreContext('/repo');
  const task = makeTask({
    reviewStatus,
  });
  await saveTask(ctx, task);
  const paths = taskDirPaths(ctx.projectRoot, task.id);
  return {
    ctx,
    taskDir: paths.dir,
    task,
  };
}

afterEach(() => {
  taskEvents.removeAllListeners();
});

//#endregion

//#region Env validation

describe('runAgentCi env validation', () => {
  it('throws when NOETIC_TASK_DIR is missing (no override, no env)', async () => {
    const seeded = await seedTaskDir();
    // Explicitly do NOT pass taskDir so the runner falls through to env.
    const prevDir = process.env.NOETIC_TASK_DIR;
    delete process.env.NOETIC_TASK_DIR;
    try {
      await expect(
        runAgentCi({
          ctx: seeded.ctx,
          spawnFn: makeSpawn(),
          workflow: 'foo.yml',
          cwd: '/repo',
        }),
      ).rejects.toThrow(/NOETIC_TASK_DIR/);
    } finally {
      if (prevDir !== undefined) {
        process.env.NOETIC_TASK_DIR = prevDir;
      }
    }
  });

  it('throws when workflow is missing', async () => {
    const seeded = await seedTaskDir();
    await expect(
      runAgentCi({
        ctx: seeded.ctx,
        spawnFn: makeSpawn(),
        taskDir: seeded.taskDir,
        cwd: '/repo',
      }),
    ).rejects.toThrow(/NOETIC_TASK_WORKFLOW/);
  });
});

//#endregion

//#region Success path (exit 0)

describe('runAgentCi exit 0', () => {
  it('writes log → task.json → event in order; flips reviewStatus to approved', async () => {
    const seeded = await seedTaskDir();
    const result = await runAgentCi({
      ctx: seeded.ctx,
      spawnFn: makeSpawn({
        exitCode: 0,
      }),
      taskDir: seeded.taskDir,
      workflow: '.github/workflows/test.yml',
      cwd: '/repo',
    });

    expect(result.exitCode).toBe(0);
    expect(result.previousReviewStatus).toBe(TaskReviewStatus.Reviewing);
    expect(result.reviewStatus).toBe(TaskReviewStatus.Approved);

    // Log: contains the system "exited with code 0" line.
    const log = await readLog(seeded.ctx, seeded.task.id);
    const exitLine = log.find((e) => e.message.includes('exited with code 0'));
    expect(exitLine).toBeDefined();
    expect(exitLine?.kind).toBe(LogEntryKind.System);

    // Task.json: reviewStatus updated to approved.
    const reloaded = await loadTask(seeded.ctx, seeded.task.id);
    expect(reloaded.reviewStatus).toBe(TaskReviewStatus.Approved);
    expect(reloaded.paused).toBe(false);

    // Events: at least one TaskReviewStatusChanged with the right payload.
    const events = await tailEvents(seeded.ctx);
    const reviewChange = events.find((e) => e.kind === EventKind.TaskReviewStatusChanged);
    expect(reviewChange).toBeDefined();
    expect(reviewChange?.payload).toMatchObject({
      previousReviewStatus: TaskReviewStatus.Reviewing,
      reviewStatus: TaskReviewStatus.Approved,
      exitCode: 0,
    });
  });

  it('emits the TaskReviewStatusChanged event on the in-process bus', async () => {
    const seeded = await seedTaskDir();
    const received: Event[] = [];
    taskEvents.on(EventKind.TaskReviewStatusChanged, (event: Event) => {
      received.push(event);
    });
    await runAgentCi({
      ctx: seeded.ctx,
      spawnFn: makeSpawn({
        exitCode: 0,
      }),
      taskDir: seeded.taskDir,
      workflow: 'foo.yml',
      cwd: '/repo',
    });
    expect(received.length).toBeGreaterThanOrEqual(1);
    const last = received[received.length - 1];
    expect(last?.taskId).toBe(seeded.task.id);
    expect(last?.payload?.exitCode).toBe(0);
  });
});

//#endregion

//#region Failure path (non-zero exit)

describe('runAgentCi non-zero exit', () => {
  it('flips reviewStatus to needs_changes and includes exit code in payload', async () => {
    const seeded = await seedTaskDir();
    const result = await runAgentCi({
      ctx: seeded.ctx,
      spawnFn: makeSpawn({
        exitCode: 7,
      }),
      taskDir: seeded.taskDir,
      workflow: 'foo.yml',
      cwd: '/repo',
    });
    expect(result.exitCode).toBe(7);
    expect(result.reviewStatus).toBe(TaskReviewStatus.NeedsChanges);

    const reloaded = await loadTask(seeded.ctx, seeded.task.id);
    expect(reloaded.reviewStatus).toBe(TaskReviewStatus.NeedsChanges);

    const log = await readLog(seeded.ctx, seeded.task.id);
    expect(log.some((e) => e.message.includes('exited with code 7'))).toBe(true);

    const events = await tailEvents(seeded.ctx);
    const reviewChange = events.find((e) => e.kind === EventKind.TaskReviewStatusChanged);
    expect(reviewChange?.payload?.exitCode).toBe(7);
    expect(reviewChange?.payload?.reviewStatus).toBe(TaskReviewStatus.NeedsChanges);
  });

  it('treats null exit code (signal-killed child) as failure', async () => {
    const seeded = await seedTaskDir();
    const result = await runAgentCi({
      ctx: seeded.ctx,
      spawnFn: makeSpawn({
        exitCode: null,
      }),
      taskDir: seeded.taskDir,
      workflow: 'foo.yml',
      cwd: '/repo',
    });
    // null code is normalized to 1 inside the runner.
    expect(result.exitCode).toBe(1);
    expect(result.reviewStatus).toBe(TaskReviewStatus.NeedsChanges);
  });

  it('rejects when the child emits an error (e.g. ENOENT for npx)', async () => {
    const seeded = await seedTaskDir();
    await expect(
      runAgentCi({
        ctx: seeded.ctx,
        spawnFn: makeSpawn({
          errorOnSpawn: new Error('ENOENT: npx not found'),
        }),
        taskDir: seeded.taskDir,
        workflow: 'foo.yml',
        cwd: '/repo',
      }),
    ).rejects.toThrow(/ENOENT/);
  });
});

//#endregion

//#region Order: audit → state → event

describe('runAgentCi commit order', () => {
  it('appends log before rewriting task.json before appending the event', async () => {
    const seeded = await seedTaskDir();
    // Decorate the FsAdapter to record write order.
    const events: Array<{
      op: string;
      path: string;
    }> = [];
    const fs = seeded.ctx.fs;
    const wrapped: TaskStoreContext = {
      projectRoot: seeded.ctx.projectRoot,
      fs: {
        ...fs,
        readFile: fs.readFile.bind(fs),
        readFileText: fs.readFileText.bind(fs),
        readdir: fs.readdir.bind(fs),
        access: fs.access.bind(fs),
        stat: fs.stat.bind(fs),
        lstat: fs.lstat.bind(fs),
        mkdir: fs.mkdir.bind(fs),
        writeFile: async (p, c) => {
          events.push({
            op: 'writeFile',
            path: p,
          });
          await fs.writeFile(p, c);
        },
        appendFile: async (p, c) => {
          events.push({
            op: 'appendFile',
            path: p,
          });
          await fs.appendFile(p, c);
        },
        rename: async (oldP, newP) => {
          events.push({
            op: 'rename',
            path: newP,
          });
          await fs.rename(oldP, newP);
        },
        rm: fs.rm.bind(fs),
      },
    };

    await runAgentCi({
      ctx: wrapped,
      spawnFn: makeSpawn({
        exitCode: 0,
      }),
      taskDir: seeded.taskDir,
      workflow: 'foo.yml',
      cwd: '/repo',
    });

    // Find indexes of the *exit* commit operations:
    // - first appendFile to log.jsonl after the exit (audit)
    // - first rename ending in /task.json after that (state)
    // - first appendFile to _events.jsonl after that (event)
    const isExitLogAppend = (e: { op: string; path: string }): boolean =>
      e.op === 'appendFile' && e.path.endsWith('/log.jsonl');
    // After the runner-start log line, the second log append is the exit line.
    const logIndices = events
      .map((e, i) => ({
        e,
        i,
      }))
      .filter(({ e }) => isExitLogAppend(e))
      .map(({ i }) => i);
    expect(logIndices.length).toBeGreaterThanOrEqual(1);
    const exitLogIdx = logIndices[logIndices.length - 1];
    const taskJsonRenameIdx = events.findIndex(
      (e, i) => i > (exitLogIdx ?? -1) && e.op === 'rename' && e.path.endsWith('/task.json'),
    );
    const eventsAppendIdx = events.findIndex(
      (e, i) => i > taskJsonRenameIdx && e.op === 'appendFile' && e.path.endsWith('/_events.jsonl'),
    );

    expect(exitLogIdx).toBeGreaterThan(-1);
    expect(taskJsonRenameIdx).toBeGreaterThan(-1);
    expect(eventsAppendIdx).toBeGreaterThan(-1);
    // audit < state < event
    expect(exitLogIdx).toBeLessThan(taskJsonRenameIdx);
    expect(taskJsonRenameIdx).toBeLessThan(eventsAppendIdx);
  });
});

//#endregion

//#region Spawn invocation

describe('runAgentCi spawn invocation', () => {
  it('passes the workflow to the agent-ci CLI through stdio inheritance', async () => {
    const seeded = await seedTaskDir();
    const spawns: Array<{
      command: string;
      args: ReadonlyArray<string>;
      options: SpawnOptions;
    }> = [];
    await runAgentCi({
      ctx: seeded.ctx,
      spawnFn: makeSpawn({
        exitCode: 0,
        spawns,
      }),
      taskDir: seeded.taskDir,
      workflow: '.github/workflows/test.yml',
      cwd: '/repo',
    });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.command).toBe('npx');
    expect(spawns[0]?.args).toEqual([
      '@redwoodjs/agent-ci',
      'run',
      '--workflow',
      '.github/workflows/test.yml',
    ]);
    expect(spawns[0]?.options.cwd).toBe('/repo');
    expect(spawns[0]?.options.stdio).toBe('inherit');
  });

  it('includes the launcher-written runner record in the start log line', async () => {
    const seeded = await seedTaskDir();
    await saveRunner(seeded.ctx, {
      taskId: seeded.task.id,
      sessionId: 'sess-1',
      pid: 7777,
      pidStarttime: 'now',
      workflow: 'foo.yml',
      startedAt: NOW,
      pausedAt: null,
    });
    await runAgentCi({
      ctx: seeded.ctx,
      spawnFn: makeSpawn({
        exitCode: 0,
      }),
      taskDir: seeded.taskDir,
      workflow: 'foo.yml',
      cwd: '/repo',
    });
    const log = await readLog(seeded.ctx, seeded.task.id);
    const startLine = log.find((e) => e.message.includes('runner started'));
    expect(startLine?.message).toContain('pid=7777');
    expect(startLine?.message).toContain('workflow=foo.yml');
  });

  it('clears the runner-state sidecar after exit', async () => {
    const seeded = await seedTaskDir();
    await saveRunner(seeded.ctx, {
      taskId: seeded.task.id,
      sessionId: 'sess-1',
      pid: 7777,
      pidStarttime: null,
      workflow: 'foo.yml',
      startedAt: NOW,
      pausedAt: null,
    });
    await runAgentCi({
      ctx: seeded.ctx,
      spawnFn: makeSpawn({
        exitCode: 0,
      }),
      taskDir: seeded.taskDir,
      workflow: 'foo.yml',
      cwd: '/repo',
    });
    const fs = seeded.ctx.fs;
    if (fs instanceof MemFs) {
      // _runner.json should not exist anymore.
      const exists = fs.files.has(`${seeded.taskDir}/_runner.json`);
      expect(exists).toBe(false);
    }
  });
});

//#endregion
