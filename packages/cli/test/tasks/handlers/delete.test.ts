import { describe, expect, it } from 'bun:test';
import { EventKind } from '@noetic/code-agent/tasks/schema';
import { listTasks, tailEvents, tryLoadTask } from '@noetic/code-agent/tasks/store/fs-node';
import type { SubprocessAdapter } from '@noetic/core';
import type { Signaller } from '../../../src/commands/builtins/tasks/agent-ci-control.js';
import {
  createTaskHandler,
  deleteTaskHandler,
} from '../../../src/commands/builtins/tasks/handlers/lifecycle.js';
import { saveRunner } from '../../../src/commands/builtins/tasks/runner-state.js';
import { makeEmptySubprocess, preloadLiveHandle } from '../_adapter-helpers.js';
import { makeStoreContext } from '../_helpers.js';

interface FakeSignallerOptions {
  readonly liveSet: ReadonlySet<number>;
  readonly startTimes?: ReadonlyMap<number, string>;
}

function makeFakeSignaller(opts: FakeSignallerOptions): Signaller {
  return {
    isAlive: (pid) => opts.liveSet.has(pid),
    startTime: (pid) => opts.startTimes?.get(pid) ?? null,
    kill: () => {},
  };
}

/**
 * Subprocess adapter preloaded with a single "live" implementer handle
 * for the given task. Tests use this to assert that the delete guard
 * sees an attached implementer through the adapter manifest rather
 * than through the old sidecar file.
 */
async function makeSubprocessWithImplementer(opts: {
  taskId: string;
  parentTaskId: string;
  featureId: string;
  pid: number;
}): Promise<SubprocessAdapter> {
  return preloadLiveHandle({
    taskId: opts.taskId,
    role: 'implementer',
    featureId: opts.featureId,
    parentTaskId: opts.parentTaskId,
    pid: opts.pid,
  });
}

describe('deleteTaskHandler', () => {
  it('emits TaskDeleted (not TaskArchived) and removes the task directory', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Delete me',
    });
    const result = await deleteTaskHandler(ctx, {
      taskId: created.task.id,
      subprocess: makeEmptySubprocess(),
    });
    expect(result.taskId).toBe(created.task.id);
    expect(await tryLoadTask(ctx, created.task.id)).toBeNull();
    expect(await listTasks(ctx)).toEqual([]);

    const events = await tailEvents(ctx);
    const deleted = events.filter((e) => e.kind === EventKind.TaskDeleted);
    expect(deleted.length).toBe(1);
    expect(deleted[0]?.payload?.reason).toBe('deleted');
    const archived = events.filter((e) => e.kind === EventKind.TaskArchived);
    expect(archived.length).toBe(0);
  });

  it('throws on missing task', async () => {
    const ctx = makeStoreContext();
    await expect(
      deleteTaskHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
        subprocess: makeEmptySubprocess(),
      }),
    ).rejects.toThrow();
  });

  it('refuses to delete when an agent-ci runner sidecar is alive', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Sidecar attached',
    });
    await saveRunner(ctx, {
      taskId: created.task.id,
      sessionId: 'S-fake',
      pid: 4242,
      pidStarttime: 'Mon Jan  1 00:00:00 2026',
      workflow: 'ci.yml',
      startedAt: '2026-05-01T00:00:00.000Z',
      pausedAt: null,
    });
    const signaller = makeFakeSignaller({
      liveSet: new Set([
        4242,
      ]),
      startTimes: new Map([
        [
          4242,
          'Mon Jan  1 00:00:00 2026',
        ],
      ]),
    });
    await expect(
      deleteTaskHandler(ctx, {
        taskId: created.task.id,
        signaller,
        subprocess: makeEmptySubprocess(),
      }),
    ).rejects.toThrow(/agent-ci runner pid=4242 still attached/);
    expect(await tryLoadTask(ctx, created.task.id)).not.toBeNull();
  });

  it('--force overrides the live-sidecar guard', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Force me',
    });
    await saveRunner(ctx, {
      taskId: created.task.id,
      sessionId: 'S-fake',
      pid: 4242,
      pidStarttime: null,
      workflow: 'ci.yml',
      startedAt: '2026-05-01T00:00:00.000Z',
      pausedAt: null,
    });
    const signaller = makeFakeSignaller({
      liveSet: new Set([
        4242,
      ]),
    });
    const result = await deleteTaskHandler(ctx, {
      taskId: created.task.id,
      force: true,
      signaller,
      subprocess: makeEmptySubprocess(),
    });
    expect(result.taskId).toBe(created.task.id);
    expect(await tryLoadTask(ctx, created.task.id)).toBeNull();
  });

  it('treats a stale (dead-pid) sidecar as not blocking', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Stale sidecar',
    });
    await saveRunner(ctx, {
      taskId: created.task.id,
      sessionId: 'S-stale',
      pid: 4242,
      pidStarttime: null,
      workflow: 'ci.yml',
      startedAt: '2026-05-01T00:00:00.000Z',
      pausedAt: null,
    });
    const signaller = makeFakeSignaller({
      liveSet: new Set(),
    });
    const result = await deleteTaskHandler(ctx, {
      taskId: created.task.id,
      signaller,
      subprocess: makeEmptySubprocess(),
    });
    expect(result.taskId).toBe(created.task.id);
  });

  it('treats a recycled-pid (mismatched startTime) sidecar as not blocking', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Recycled pid',
    });
    await saveRunner(ctx, {
      taskId: created.task.id,
      sessionId: 'S-recycled',
      pid: 4242,
      pidStarttime: 'Mon Jan  1 00:00:00 2026',
      workflow: 'ci.yml',
      startedAt: '2026-05-01T00:00:00.000Z',
      pausedAt: null,
    });
    const signaller = makeFakeSignaller({
      liveSet: new Set([
        4242,
      ]),
      startTimes: new Map([
        [
          4242,
          'Mon Feb  1 00:00:00 2026',
        ],
      ]),
    });
    const result = await deleteTaskHandler(ctx, {
      taskId: created.task.id,
      signaller,
      subprocess: makeEmptySubprocess(),
    });
    expect(result.taskId).toBe(created.task.id);
  });

  it('treats a live pid whose startTime probe returns null as not blocking', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'ps failed',
    });
    await saveRunner(ctx, {
      taskId: created.task.id,
      sessionId: 'S-ps-failed',
      pid: 4242,
      pidStarttime: 'Mon Jan  1 00:00:00 2026',
      workflow: 'ci.yml',
      startedAt: '2026-05-01T00:00:00.000Z',
      pausedAt: null,
    });
    const signaller = makeFakeSignaller({
      liveSet: new Set([
        4242,
      ]),
    });
    const result = await deleteTaskHandler(ctx, {
      taskId: created.task.id,
      signaller,
      subprocess: makeEmptySubprocess(),
    });
    expect(result.taskId).toBe(created.task.id);
  });

  it('refuses to delete when sidecar has null pidStarttime and pid is alive', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'No starttime',
    });
    await saveRunner(ctx, {
      taskId: created.task.id,
      sessionId: 'S-no-starttime',
      pid: 4242,
      pidStarttime: null,
      workflow: 'ci.yml',
      startedAt: '2026-05-01T00:00:00.000Z',
      pausedAt: null,
    });
    const signaller = makeFakeSignaller({
      liveSet: new Set([
        4242,
      ]),
    });
    await expect(
      deleteTaskHandler(ctx, {
        taskId: created.task.id,
        signaller,
        subprocess: makeEmptySubprocess(),
      }),
    ).rejects.toThrow(/agent-ci runner pid=4242 still attached/);
  });

  it('refuses to delete when an implementer subprocess handle is live', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Implementer attached',
    });
    const subprocess = await makeSubprocessWithImplementer({
      taskId: created.task.id,
      parentTaskId: 'T-parent0000',
      featureId: 'F-abc1234567',
      pid: 5151,
    });
    await expect(
      deleteTaskHandler(ctx, {
        taskId: created.task.id,
        subprocess,
      }),
    ).rejects.toThrow(/implementer runner pid=5151 still attached/);
    expect(await tryLoadTask(ctx, created.task.id)).not.toBeNull();
  });
});
