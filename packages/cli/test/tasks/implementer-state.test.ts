import { describe, expect, it } from 'bun:test';

import {
  clearImplementer,
  ImplementerStateSchema,
  loadImplementer,
  saveImplementer,
} from '../../src/commands/builtins/tasks/implementer-state.js';
import { makeStoreContext } from './_helpers.js';

function makeState(
  overrides: Partial<{
    taskId: string;
    parentTaskId: string;
    featureId: string;
    pid: number;
    pidStarttime: string | null;
    worktreePath: string;
    branch: string;
  }>,
) {
  return {
    taskId: overrides.taskId ?? 'T-leaf000000',
    parentTaskId: overrides.parentTaskId ?? 'T-parent0000',
    featureId: overrides.featureId ?? 'F-abc1234567',
    sessionId: 'S-fake-session',
    pid: overrides.pid ?? 4242,
    pidStarttime: overrides.pidStarttime ?? null,
    worktreePath: overrides.worktreePath ?? '/repo/.worktrees/feat-x',
    branch: overrides.branch ?? 'feat/x',
    startedAt: '2026-05-01T00:00:00.000Z',
    pausedAt: null,
  };
}

describe('ImplementerStateSchema', () => {
  it('rejects negative pids', () => {
    expect(() =>
      ImplementerStateSchema.parse(
        makeState({
          pid: -1,
        }),
      ),
    ).toThrow();
  });

  it('rejects empty session id, branch, or worktreePath', () => {
    expect(() =>
      ImplementerStateSchema.parse({
        ...makeState({}),
        sessionId: '',
      }),
    ).toThrow();
    expect(() =>
      ImplementerStateSchema.parse({
        ...makeState({}),
        branch: '',
      }),
    ).toThrow();
    expect(() =>
      ImplementerStateSchema.parse({
        ...makeState({}),
        worktreePath: '',
      }),
    ).toThrow();
  });

  it('rejects malformed task ids', () => {
    expect(() =>
      ImplementerStateSchema.parse(
        makeState({
          taskId: 'not-a-task-id',
        }),
      ),
    ).toThrow();
    expect(() =>
      ImplementerStateSchema.parse(
        makeState({
          parentTaskId: 'T-too-short',
        }),
      ),
    ).toThrow();
  });
});

describe('saveImplementer / loadImplementer / clearImplementer', () => {
  it('round-trips a written state', async () => {
    const ctx = makeStoreContext();
    const state = makeState({
      taskId: 'T-aaaaaaaaaa',
    });
    await saveImplementer(ctx, state);
    const loaded = await loadImplementer(ctx, state.taskId);
    expect(loaded).toEqual(state);
  });

  it('returns null when no sidecar exists', async () => {
    const ctx = makeStoreContext();
    expect(await loadImplementer(ctx, 'T-aaaaaaaaaa')).toBeNull();
  });

  it('clear is a no-op when sidecar is missing', async () => {
    const ctx = makeStoreContext();
    await clearImplementer(ctx, 'T-aaaaaaaaaa');
    expect(await loadImplementer(ctx, 'T-aaaaaaaaaa')).toBeNull();
  });

  it('clear removes a written sidecar', async () => {
    const ctx = makeStoreContext();
    const state = makeState({
      taskId: 'T-bbbbbbbbbb',
    });
    await saveImplementer(ctx, state);
    expect(await loadImplementer(ctx, state.taskId)).not.toBeNull();
    await clearImplementer(ctx, state.taskId);
    expect(await loadImplementer(ctx, state.taskId)).toBeNull();
  });

  it('overwrites an existing sidecar atomically', async () => {
    const ctx = makeStoreContext();
    const first = makeState({
      taskId: 'T-cccccccccc',
      pid: 1000,
    });
    const second = makeState({
      taskId: 'T-cccccccccc',
      pid: 2000,
    });
    await saveImplementer(ctx, first);
    await saveImplementer(ctx, second);
    const loaded = await loadImplementer(ctx, 'T-cccccccccc');
    expect(loaded?.pid).toBe(2000);
  });

  it('rejects malformed task ids on load and clear', async () => {
    const ctx = makeStoreContext();
    await expect(loadImplementer(ctx, 'bad-id')).rejects.toThrow();
    await expect(clearImplementer(ctx, 'bad-id')).rejects.toThrow();
  });
});
