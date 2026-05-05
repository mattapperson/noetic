import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Event, LogEntry, Task } from '@noetic/code-agent/tasks/schema';
import {
  AutopilotState,
  EventKind,
  generateTaskId,
  LogEntryKind,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import {
  appendEvent,
  appendLog,
  deleteTaskDir,
  hasHierarchy,
  listTasks,
  loadState,
  loadTask,
  readLog,
  saveTask,
  tailEvents,
  tailLog,
  taskDirPaths,
  taskRootPaths,
  tryLoadTask,
} from '@noetic/code-agent/tasks/store/fs-node';
import { createLocalFsAdapter } from '@noetic/core';
import { MemFs, makeStoreContext } from './_helpers.js';

//#region Helpers

function makeTask(overrides: Partial<Task> = {}): Task {
  const id = overrides.id ?? generateTaskId();
  const now = '2026-04-30T00:00:00.000Z';
  return {
    id,
    source: TaskSource.Manual,
    title: 'Test task',
    projectRoot: '/repo',
    worktreePath: null,
    branch: null,
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
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

//#endregion

//#region saveTask / loadTask / tryLoadTask / listTasks

describe('saveTask / loadTask', () => {
  it('round-trips a task through MemFs', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();

    await saveTask(ctx, t);
    const loaded = await loadTask(ctx, t.id);

    expect(loaded).toEqual(t);
  });

  it('throws on missing task', async () => {
    const ctx = makeStoreContext();
    await expect(loadTask(ctx, 'T-abcdefghij')).rejects.toThrow(/not found/);
  });

  it('throws on invalid task id', async () => {
    const ctx = makeStoreContext();
    await expect(loadTask(ctx, 'bad-id')).rejects.toThrow();
  });

  it('throws on corrupted task.json', async () => {
    const ctx = makeStoreContext();
    const taskId = 'T-corrupted0';
    const paths = taskDirPaths(ctx, taskId);
    await ctx.fs.mkdir(paths.dir);
    await ctx.fs.writeFile(paths.task, '{ this is not json');

    await expect(loadTask(ctx, taskId)).rejects.toThrow(/Failed to parse JSON/);
  });

  it('tryLoadTask returns null for missing, malformed, or invalid id', async () => {
    const ctx = makeStoreContext();
    expect(await tryLoadTask(ctx, 'T-abcdefghij')).toBeNull();
    expect(await tryLoadTask(ctx, 'bad-id')).toBeNull();

    const taskId = 'T-corrupted1';
    const paths = taskDirPaths(ctx, taskId);
    await ctx.fs.mkdir(paths.dir);
    await ctx.fs.writeFile(paths.task, '{ this is not json');
    expect(await tryLoadTask(ctx, taskId)).toBeNull();
  });
});

describe('listTasks', () => {
  it('returns [] when the tasks dir does not exist', async () => {
    const ctx = makeStoreContext();
    expect(await listTasks(ctx)).toEqual([]);
  });

  it('returns every well-formed task and skips _ underscored entries', async () => {
    const ctx = makeStoreContext();
    const a = makeTask({
      id: 'T-aaaaaaaaaa',
    });
    const b = makeTask({
      id: 'T-bbbbbbbbbb',
    });
    await saveTask(ctx, a);
    await saveTask(ctx, b);
    // Underscored sibling that should be ignored
    const root = taskRootPaths(ctx).root;
    await ctx.fs.writeFile(join(root, '_state.json'), '{"schemaVersion":1,"lastEventId":0}');

    const tasks = await listTasks(ctx);
    const ids = new Set(tasks.map((t) => t.id));
    expect(ids).toEqual(
      new Set([
        a.id,
        b.id,
      ]),
    );
  });

  it('skips entries with malformed task.json without throwing', async () => {
    const ctx = makeStoreContext();
    const good = makeTask({
      id: 'T-goodtask01',
    });
    await saveTask(ctx, good);
    const badId = 'T-badtask002';
    const paths = taskDirPaths(ctx, badId);
    await ctx.fs.mkdir(paths.dir);
    await ctx.fs.writeFile(paths.task, '{ malformed');

    const tasks = await listTasks(ctx);
    expect(tasks.map((t) => t.id)).toEqual([
      good.id,
    ]);
  });
});

//#endregion

//#region delete + hierarchy

describe('deleteTaskDir', () => {
  it('removes the entire task directory', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);
    await appendLog(ctx, {
      taskId: t.id,
      entry: {
        kind: LogEntryKind.Log,
        ts: '2026-04-30T00:00:00.000Z',
        message: 'hello',
      },
    });

    await deleteTaskDir(ctx, t.id);

    expect(await tryLoadTask(ctx, t.id)).toBeNull();
    expect(await readLog(ctx, t.id)).toEqual([]);
  });

  it('is a no-op when the task does not exist (force)', async () => {
    const ctx = makeStoreContext();
    await deleteTaskDir(ctx, 'T-abcdefghij');
  });
});

describe('hasHierarchy', () => {
  it('returns false when no hierarchy/ subdir exists', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);
    expect(await hasHierarchy(ctx, t.id)).toBe(false);
  });

  it('returns true once the hierarchy subdir is created', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);
    const paths = taskDirPaths(ctx, t.id);
    await ctx.fs.mkdir(paths.hierarchy);
    expect(await hasHierarchy(ctx, t.id)).toBe(true);
  });
});

//#endregion

//#region appendLog / readLog / tailLog

describe('appendLog / readLog / tailLog', () => {
  it('round-trips a single log entry', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);

    await appendLog(ctx, {
      taskId: t.id,
      entry: {
        kind: LogEntryKind.Log,
        ts: '2026-04-30T00:00:00.000Z',
        message: 'first line',
      },
    });

    const entries = await readLog(ctx, t.id);
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry?.kind).toBe(LogEntryKind.Log);
    expect(entry?.message).toBe('first line');
    expect(entry?.chunk).toBeUndefined();
  });

  it('appends across calls without overwriting', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);

    for (let i = 0; i < 5; i++) {
      await appendLog(ctx, {
        taskId: t.id,
        entry: {
          kind: LogEntryKind.System,
          ts: '2026-04-30T00:00:00.000Z',
          message: `line ${i}`,
        },
      });
    }

    const entries = await readLog(ctx, t.id);
    expect(entries.map((e) => e.message)).toEqual([
      'line 0',
      'line 1',
      'line 2',
      'line 3',
      'line 4',
    ]);
  });

  it('splits messages over LOG_LINE_MAX_BYTES into chunked entries', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);
    const big = 'x'.repeat(7 * 1024); // 7 KiB > 3 KiB cap

    await appendLog(ctx, {
      taskId: t.id,
      entry: {
        kind: LogEntryKind.Log,
        ts: '2026-04-30T00:00:00.000Z',
        message: big,
      },
    });

    const entries = await readLog(ctx, t.id);
    expect(entries.length).toBeGreaterThan(1);
    const total = entries.map((e) => e.message).join('');
    expect(total).toBe(big);
    const counts = new Set(entries.map((e) => e.chunkCount));
    expect(counts.size).toBe(1);
    expect(entries.every((e, i) => e.chunk === i + 1)).toBe(true);
  });

  it('readLog returns [] when the log file does not exist', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);
    expect(await readLog(ctx, t.id)).toEqual([]);
  });

  it('tailLog returns at most n most recent entries', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);
    for (let i = 0; i < 7; i++) {
      await appendLog(ctx, {
        taskId: t.id,
        entry: {
          kind: LogEntryKind.Log,
          ts: '2026-04-30T00:00:00.000Z',
          message: String(i),
        },
      });
    }

    const tail = await tailLog(ctx, {
      taskId: t.id,
      n: 3,
    });
    expect(tail.map((e) => e.message)).toEqual([
      '4',
      '5',
      '6',
    ]);
  });

  it('tailLog returns everything when n exceeds total', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);
    await appendLog(ctx, {
      taskId: t.id,
      entry: {
        kind: LogEntryKind.Log,
        ts: '2026-04-30T00:00:00.000Z',
        message: 'only',
      },
    });

    const tail = await tailLog(ctx, {
      taskId: t.id,
      n: 50,
    });
    expect(tail).toHaveLength(1);
  });
});

//#endregion

//#region appendEvent / tailEvents / loadState

describe('appendEvent / tailEvents / loadState', () => {
  it('initial state has lastEventId 0', async () => {
    const ctx = makeStoreContext();
    const s = await loadState(ctx);
    expect(s.lastEventId).toBe(0);
    expect(s.schemaVersion).toBe(1);
  });

  it('appendEvent increments id and returns the persisted event', async () => {
    const ctx = makeStoreContext();
    const taskId = 'T-eventroot1';

    const e1 = await appendEvent(ctx, {
      taskId,
      kind: EventKind.TaskCreated,
      ts: '2026-04-30T00:00:00.000Z',
    });
    const e2 = await appendEvent(ctx, {
      taskId,
      kind: EventKind.TaskUpdated,
      ts: '2026-04-30T00:00:01.000Z',
    });

    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
    const s = await loadState(ctx);
    expect(s.lastEventId).toBe(2);
  });

  it('tailEvents returns events strictly greater than sinceId', async () => {
    const ctx = makeStoreContext();
    const taskId = 'T-eventroot2';
    for (let i = 0; i < 4; i++) {
      await appendEvent(ctx, {
        taskId,
        kind: EventKind.LogAppended,
        ts: '2026-04-30T00:00:00.000Z',
        payload: {
          i,
        },
      });
    }

    expect((await tailEvents(ctx)).map((e) => e.id)).toEqual([
      1,
      2,
      3,
      4,
    ]);
    expect((await tailEvents(ctx, 2)).map((e) => e.id)).toEqual([
      3,
      4,
    ]);
    expect(await tailEvents(ctx, 99)).toEqual([]);
  });

  it('tailEvents returns [] when the events file does not exist', async () => {
    const ctx = makeStoreContext();
    expect(await tailEvents(ctx)).toEqual([]);
  });

  it('persists state before event so a tailer cannot see id > lastEventId', async () => {
    const ctx = makeStoreContext();
    await appendEvent(ctx, {
      taskId: null,
      kind: EventKind.MilestoneCreated,
      ts: '2026-04-30T00:00:00.000Z',
    });

    const state = await loadState(ctx);
    const events = await tailEvents(ctx);
    for (const e of events) {
      expect(e.id).toBeLessThanOrEqual(state.lastEventId);
    }
  });
});

//#endregion

//#region End-to-end on real local FS

describe('saveTask + appendLog (real local fs)', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'noetic-fs-store-'));
  });

  afterEach(async () => {
    await rm(dir, {
      recursive: true,
      force: true,
    });
  });

  it('writes task.json and log.jsonl beneath <tasksRoot>/<taskId>', async () => {
    const ctx: TaskStoreContext = {
      fs: createLocalFsAdapter(),
      projectRoot: dir,
      tasksRoot: join(dir, 'tasks'),
    };
    const t = makeTask({
      id: 'T-realfs0001',
      projectRoot: dir,
    });
    await saveTask(ctx, t);
    await appendLog(ctx, {
      taskId: t.id,
      entry: {
        kind: LogEntryKind.System,
        ts: '2026-04-30T00:00:00.000Z',
        message: 'spawned',
      },
    });

    const loaded = await loadTask(ctx, t.id);
    expect(loaded).toEqual(t);
    const log = await readLog(ctx, t.id);
    expect(log).toHaveLength(1);
    const entry = log[0];
    expect(entry?.message).toBe('spawned');
  });
});

//#endregion

//#region MemFs sanity (verifies the helper itself)

describe('MemFs sanity', () => {
  it('errors on writes whose parent directory does not exist', async () => {
    const fs = new MemFs();
    await expect(fs.writeFile('/nope/file.txt', 'x')).rejects.toThrow(/ENOENT/);
  });

  it('round-trips appendFile across calls', async () => {
    const fs = new MemFs([
      '/d',
    ]);
    await fs.appendFile('/d/log', 'a\n');
    await fs.appendFile('/d/log', 'b\n');
    expect(await fs.readFileText('/d/log')).toBe('a\nb\n');
  });

  it('rm recursively removes a tree', async () => {
    const fs = new MemFs([
      '/d',
    ]);
    await fs.mkdir('/d/sub');
    await fs.writeFile('/d/sub/x', '1');
    await fs.rm('/d', {
      recursive: true,
    });
    await expect(fs.access('/d')).rejects.toThrow();
  });
});

//#endregion

// Ensure unused-import linter does not warn.
const _typeProbe: Event | LogEntry | null = null;
void _typeProbe;
