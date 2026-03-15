import { describe, it, expect } from 'bun:test';
import { durableTaskState } from '../../src/memory/layers/durable-task-state';
import type { ScopedStorage, ExecutionContext } from '../../src/types/memory';

function makeStorage(): ScopedStorage {
  const store = new Map<string, unknown>();
  return {
    async get(key) { return store.get(key) as any ?? null; },
    async set(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list(prefix) { return [...store.keys()]; },
  };
}

function makeCtx(): ExecutionContext {
  return { executionId: 'exec-1', threadId: 'thread-1', depth: 0 };
}

describe('durableTaskState', () => {
  it('has correct id and slot', () => {
    const layer = durableTaskState();
    expect(layer.id).toBe('durable-task-state');
    expect(layer.slot).toBe(110);
    expect(layer.scope).toBe('execution');
  });

  it('init/recall/store lifecycle', async () => {
    const layer = durableTaskState();
    const result = await layer.hooks.init!({ storage: makeStorage(), scopeKey: 'exec-1', ctx: makeCtx() });
    expect(result.state).toEqual({ checkpoints: [], files: [], data: {} });

    const recalled = await layer.hooks.recall!({ log: { items: [], append: () => {} } as any, query: '', ctx: makeCtx(), state: result.state, budget: 500 });
    expect(recalled).not.toBeNull();
    expect((recalled!.items[0] as any).content[0].text).toContain('<task_state>');
  });

  it('onSpawn always provides child state', async () => {
    const layer = durableTaskState();
    const parentState = { checkpoints: [{ timestamp: 1, depth: 0 }], files: ['a.ts'], data: { key: 'val' } };
    const result = await layer.hooks.onSpawn!({ parentState, childCtx: makeCtx(), spawnOpts: { contextIn: 'fresh', contextOut: 'full' } });
    expect(result).not.toBeNull();
    expect(result!.childState).toEqual(parentState);
    // Should be a clone
    expect(result!.childState).not.toBe(parentState);
  });

  it('onReturn merges child artifacts back', async () => {
    const layer = durableTaskState();
    const parentState = { checkpoints: [{ timestamp: 1, depth: 0 }], files: ['a.ts'], data: { x: 1 } };
    const childState = { checkpoints: [{ timestamp: 2, depth: 0 }], files: ['b.ts'], data: { y: 2 } };
    const result = await layer.hooks.onReturn!({
      childState, childLog: { items: [], append: () => {} } as any, parentState, result: 'done',
    });
    expect(result).toBeDefined();
    expect((result as any).parentState.checkpoints).toHaveLength(2);
    expect((result as any).parentState.files).toContain('a.ts');
    expect((result as any).parentState.files).toContain('b.ts');
    expect((result as any).parentState.data).toEqual({ x: 1, y: 2 });
  });
});
