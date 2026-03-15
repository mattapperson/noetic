import { describe, it, expect } from 'bun:test';
import { observationalMemory } from '../../src/memory/layers/observational-memory';
import { makeScopedStorage as makeStorage, makeCtx } from '../_helpers';
import type { MessageItem } from '../../src/types/items';

describe('observationalMemory', () => {
  it('has correct id and slot', () => {
    const layer = observationalMemory();
    expect(layer.id).toBe('observational-memory');
    expect(layer.slot).toBe(200);
  });

  it('init loads state from storage', async () => {
    const layer = observationalMemory();
    const result = await layer.hooks.init!({ storage: makeStorage(), scopeKey: 'user-1', ctx: makeCtx() });
    expect(result.state).toEqual({ observations: [], buffer: [], version: 0 });
  });

  it('recall renders observations', async () => {
    const layer = observationalMemory();
    const state = { observations: ['Tool X returns errors', 'User prefers JSON'], buffer: [], version: 1 };
    const result = await layer.hooks.recall!({ log: { items: [], append: () => {} } as any, query: '', ctx: makeCtx(), state, budget: 1000 });
    expect(result).not.toBeNull();
    expect((result!.items[0] as any).content[0].text).toContain('Tool X returns errors');
  });

  it('store accumulates and compresses at threshold', async () => {
    const layer = observationalMemory({ bufferThreshold: 2 });
    const state = { observations: [], buffer: [], version: 0 };
    const msg: MessageItem = { id: '1', status: 'completed', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'test output' }] };

    // First store: buffer grows
    const r1 = await layer.hooks.store!({ newItems: [msg], log: { items: [], append: () => {} } as any, response: { items: [msg], usage: { inputTokens: 0, outputTokens: 0 } }, ctx: makeCtx(), state });
    expect((r1 as any).state.buffer).toHaveLength(1);

    // Second store: threshold reached, compresses
    const r2 = await layer.hooks.store!({ newItems: [msg], log: { items: [], append: () => {} } as any, response: { items: [msg], usage: { inputTokens: 0, outputTokens: 0 } }, ctx: makeCtx(), state: (r1 as any).state });
    expect((r2 as any).state.observations).toHaveLength(1);
    expect((r2 as any).state.observations[0]).toContain('Processed 2 items');
    expect((r2 as any).state.buffer).toHaveLength(0);
  });

  it('onSpawn clones state', async () => {
    const layer = observationalMemory();
    const parentState = { observations: ['obs1'], buffer: ['buf1'], version: 1 };
    const result = await layer.hooks.onSpawn!({ parentState, childCtx: makeCtx(), spawnOpts: { contextIn: 'fresh', contextOut: 'full' } });
    expect(result!.childState).toEqual(parentState);
    expect(result!.childState).not.toBe(parentState);
  });
});
