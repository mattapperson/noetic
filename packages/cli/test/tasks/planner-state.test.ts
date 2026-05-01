import { describe, expect, it } from 'bun:test';

import {
  clearPlanner,
  loadPlanner,
  PlannerStateSchema,
  savePlanner,
} from '../../src/commands/builtins/tasks/planner-state.js';
import { makeStoreContext } from './_helpers.js';

function makeState(
  overrides: Partial<{
    taskId: string;
    pid: number;
    pidStarttime: string | null;
  }>,
) {
  return {
    taskId: overrides.taskId ?? 'T-plan000000',
    sessionId: 'S-plan-fake',
    pid: overrides.pid ?? 4242,
    pidStarttime: overrides.pidStarttime ?? null,
    startedAt: '2026-05-01T00:00:00.000Z',
    pausedAt: null,
  };
}

describe('PlannerStateSchema', () => {
  it('rejects negative pid', () => {
    expect(() =>
      PlannerStateSchema.parse(
        makeState({
          pid: -1,
        }),
      ),
    ).toThrow();
  });

  it('rejects empty session id', () => {
    expect(() =>
      PlannerStateSchema.parse({
        ...makeState({}),
        sessionId: '',
      }),
    ).toThrow();
  });

  it('rejects malformed task ids', () => {
    expect(() =>
      PlannerStateSchema.parse(
        makeState({
          taskId: 'not-a-task-id',
        }),
      ),
    ).toThrow();
  });
});

describe('savePlanner / loadPlanner / clearPlanner', () => {
  it('round-trips a written state', async () => {
    const ctx = makeStoreContext();
    const state = makeState({
      taskId: 'T-aaaaaaaaaa',
    });
    await savePlanner(ctx, state);
    expect(await loadPlanner(ctx, state.taskId)).toEqual(state);
  });

  it('returns null when no sidecar exists', async () => {
    const ctx = makeStoreContext();
    expect(await loadPlanner(ctx, 'T-aaaaaaaaaa')).toBeNull();
  });

  it('clear is a no-op when sidecar is missing', async () => {
    const ctx = makeStoreContext();
    await clearPlanner(ctx, 'T-aaaaaaaaaa');
    expect(await loadPlanner(ctx, 'T-aaaaaaaaaa')).toBeNull();
  });

  it('clear removes a written sidecar', async () => {
    const ctx = makeStoreContext();
    const state = makeState({
      taskId: 'T-bbbbbbbbbb',
    });
    await savePlanner(ctx, state);
    expect(await loadPlanner(ctx, state.taskId)).not.toBeNull();
    await clearPlanner(ctx, state.taskId);
    expect(await loadPlanner(ctx, state.taskId)).toBeNull();
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
    await savePlanner(ctx, first);
    await savePlanner(ctx, second);
    const loaded = await loadPlanner(ctx, 'T-cccccccccc');
    expect(loaded?.pid).toBe(2000);
  });

  it('rejects malformed task ids on load and clear', async () => {
    const ctx = makeStoreContext();
    await expect(loadPlanner(ctx, 'bad-id')).rejects.toThrow();
    await expect(clearPlanner(ctx, 'bad-id')).rejects.toThrow();
  });
});
