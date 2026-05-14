/**
 * Unit tests for the adapter-based task handle lookup.
 *
 * Uses `createInMemorySubprocessAdapter` — the same durable in-memory
 * adapter the runtime uses for unit-tested paths — so the manifest
 * semantics under test are identical to what production sees at the
 * adapter boundary.
 */

import { describe, expect, it } from 'bun:test';

import type { SubprocessHandle } from '@noetic-tools/core';
import { createInMemoryStorage, createInMemorySubprocessAdapter } from '@noetic-tools/core';

import {
  findLiveTaskHandle,
  listLiveTaskHandles,
  TaskRole,
} from '../../src/tasks/task-runtime-index.js';

interface FakeSpawn {
  readonly taskId: string;
  readonly taskRole: TaskRole;
  readonly featureId?: string;
}

/**
 * Build an adapter whose `run` hook never resolves — keeps every
 * spawned process-kind handle in the `active` set so `listLive` has
 * something to surface. Tests inspect the handle metadata only, they
 * don't need the run to terminate.
 */
function hangingAdapter(): ReturnType<typeof createInMemorySubprocessAdapter> {
  return createInMemorySubprocessAdapter({
    storage: createInMemoryStorage(),
    run: () => new Promise<void>(() => undefined),
  });
}

async function seed(
  adapter: ReturnType<typeof createInMemorySubprocessAdapter>,
  specs: ReadonlyArray<FakeSpawn>,
): Promise<ReadonlyArray<SubprocessHandle>> {
  const handles: SubprocessHandle[] = [];
  for (const spec of specs) {
    const handle = await adapter.spawn({
      kind: 'process',
      command: 'bash',
      args: [
        '-c',
        'sleep 60',
      ],
      metadata: {
        taskRole: spec.taskRole,
        taskId: spec.taskId,
        featureId: spec.featureId,
      },
    });
    handles.push(handle);
  }
  return handles;
}

describe('findLiveTaskHandle', () => {
  it('returns the handle matching (taskId, taskRole)', async () => {
    const adapter = hangingAdapter();
    await seed(adapter, [
      {
        taskId: 'T-a',
        taskRole: TaskRole.Planner,
      },
      {
        taskId: 'T-b',
        taskRole: TaskRole.Planner,
      },
    ]);
    const found = await findLiveTaskHandle({
      adapter,
      taskId: 'T-a',
      taskRole: TaskRole.Planner,
    });
    expect(found).not.toBeNull();
    expect(found?.metadata?.taskId).toBe('T-a');
  });

  it('returns null when no handle matches', async () => {
    const adapter = hangingAdapter();
    await seed(adapter, [
      {
        taskId: 'T-a',
        taskRole: TaskRole.Planner,
      },
    ]);
    const found = await findLiveTaskHandle({
      adapter,
      taskId: 'T-missing',
      taskRole: TaskRole.Planner,
    });
    expect(found).toBeNull();
  });

  it('distinguishes by taskRole for the same taskId', async () => {
    const adapter = hangingAdapter();
    await seed(adapter, [
      {
        taskId: 'T-shared',
        taskRole: TaskRole.Planner,
      },
      {
        taskId: 'T-shared',
        taskRole: TaskRole.Implementer,
        featureId: 'f1',
      },
    ]);
    const planner = await findLiveTaskHandle({
      adapter,
      taskId: 'T-shared',
      taskRole: TaskRole.Planner,
    });
    const impl = await findLiveTaskHandle({
      adapter,
      taskId: 'T-shared',
      taskRole: TaskRole.Implementer,
      featureId: 'f1',
    });
    expect(planner?.metadata?.taskRole).toBe('planner');
    expect(impl?.metadata?.taskRole).toBe('implementer');
  });

  it('uses featureId as a tiebreaker for multi-instance roles', async () => {
    const adapter = hangingAdapter();
    await seed(adapter, [
      {
        taskId: 'T-x',
        taskRole: TaskRole.Implementer,
        featureId: 'f1',
      },
      {
        taskId: 'T-x',
        taskRole: TaskRole.Implementer,
        featureId: 'f2',
      },
    ]);
    const f1 = await findLiveTaskHandle({
      adapter,
      taskId: 'T-x',
      taskRole: TaskRole.Implementer,
      featureId: 'f1',
    });
    const f2 = await findLiveTaskHandle({
      adapter,
      taskId: 'T-x',
      taskRole: TaskRole.Implementer,
      featureId: 'f2',
    });
    expect(f1?.metadata?.featureId).toBe('f1');
    expect(f2?.metadata?.featureId).toBe('f2');
    const missing = await findLiveTaskHandle({
      adapter,
      taskId: 'T-x',
      taskRole: TaskRole.Implementer,
      featureId: 'f3',
    });
    expect(missing).toBeNull();
  });
});

describe('listLiveTaskHandles', () => {
  it('returns every handle for a task regardless of role', async () => {
    const adapter = hangingAdapter();
    await seed(adapter, [
      {
        taskId: 'T-multi',
        taskRole: TaskRole.Planner,
      },
      {
        taskId: 'T-multi',
        taskRole: TaskRole.Implementer,
        featureId: 'f1',
      },
      {
        taskId: 'T-other',
        taskRole: TaskRole.Planner,
      },
    ]);
    const handles = await listLiveTaskHandles(adapter, 'T-multi');
    expect(handles.length).toBe(2);
    const roles = handles.map((h) => h.metadata?.taskRole);
    expect(roles).toContain('planner');
    expect(roles).toContain('implementer');
  });

  it('returns empty for a task with no live runners', async () => {
    const adapter = hangingAdapter();
    const handles = await listLiveTaskHandles(adapter, 'T-none');
    expect(handles.length).toBe(0);
  });
});
