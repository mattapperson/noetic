import { describe, it, expect } from 'bun:test';
import { workingMemory } from '../../src/memory/layers/working-memory';
import { makeScopedStorage as makeStorage, makeCtx, makeItemLog } from '../_helpers';
import type { FunctionCallItem, MessageItem } from '../../src/types/items';

describe('workingMemory layer', () => {
  it('has correct id and slot', () => {
    const layer = workingMemory();
    expect(layer.id).toBe('working-memory');
    expect(layer.slot).toBe(100);
    expect(layer.scope).toBe('thread');
  });

  it('init loads from storage', async () => {
    const storage = makeStorage();
    await storage.set('state', { notes: 'hello' });
    const layer = workingMemory();
    const result = await layer.hooks.init!({ storage, scopeKey: 'thread-1', ctx: makeCtx() });
    expect(result.state).toEqual({ notes: 'hello' });
  });

  it('init defaults to empty string for non-schema mode', async () => {
    const layer = workingMemory();
    const result = await layer.hooks.init!({ storage: makeStorage(), scopeKey: 'thread-1', ctx: makeCtx() });
    expect(result.state).toBe('');
  });

  it('recall renders working_memory block', async () => {
    const layer = workingMemory();
    const result = await layer.hooks.recall!({
      log: makeItemLog(), query: '', ctx: makeCtx(),
      state: { notes: 'important' }, budget: 1000,
    });
    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(1);
    const msg = result!.items[0] as MessageItem;
    expect(msg.role).toBe('developer');
    const text = msg.content[0] as { type: string; text: string };
    expect(text.text).toContain('<working_memory>');
    expect(text.text).toContain('important');
  });

  it('recall returns null when empty', async () => {
    const layer = workingMemory();
    const result = await layer.hooks.recall!({
      log: makeItemLog(), query: '', ctx: makeCtx(),
      state: '', budget: 1000,
    });
    expect(result).toBeNull();
  });

  it('recall returns null when empty object', async () => {
    const layer = workingMemory();
    const result = await layer.hooks.recall!({
      log: makeItemLog(), query: '', ctx: makeCtx(),
      state: {}, budget: 1000,
    });
    expect(result).toBeNull();
  });

  it('store watches for updateWorkingMemory', async () => {
    const layer = workingMemory();
    const funcCall: FunctionCallItem = {
      id: 'fc1', status: 'completed', type: 'function_call',
      call_id: 'c1', name: 'updateWorkingMemory', arguments: '{"notes":"updated"}',
    };
    const result = await layer.hooks.store!({
      newItems: [funcCall], log: makeItemLog(),
      response: { items: [funcCall], usage: { inputTokens: 0, outputTokens: 0 } },
      ctx: makeCtx(), state: { existing: true },
    });
    expect((result as any).state.notes).toBe('updated');
    expect((result as any).state.existing).toBe(true); // shallow merged via spread
  });

  it('store does not update in readOnly mode', async () => {
    const layer = workingMemory({ readOnly: true });
    const funcCall: FunctionCallItem = {
      id: 'fc1', status: 'completed', type: 'function_call',
      call_id: 'c1', name: 'updateWorkingMemory', arguments: '{"notes":"updated"}',
    };
    const result = await layer.hooks.store!({
      newItems: [funcCall], log: makeItemLog(),
      response: { items: [funcCall], usage: { inputTokens: 0, outputTokens: 0 } },
      ctx: makeCtx(), state: { existing: true },
    });
    expect(result).toBeUndefined();
  });

  it('onSpawn propagates for resource scope', async () => {
    const layer = workingMemory({ scope: 'resource' });
    const result = await layer.hooks.onSpawn!({
      parentState: { data: 'parent' },
      childCtx: makeCtx(),
      spawnOpts: { contextIn: 'none', contextOut: 'none' },
    });
    expect(result!.childState).toEqual({ data: 'parent' });
  });

  it('onSpawn returns null for thread scope', async () => {
    const layer = workingMemory({ scope: 'thread' });
    const result = await layer.hooks.onSpawn!({
      parentState: { data: 'parent' },
      childCtx: makeCtx(),
      spawnOpts: { contextIn: 'none', contextOut: 'none' },
    });
    expect(result).toBeNull();
  });

  it('store performs shallow merge (nested objects overwritten)', async () => {
    const layer = workingMemory();
    const funcCall: FunctionCallItem = {
      id: 'fc1', status: 'completed', type: 'function_call',
      call_id: 'c1', name: 'updateWorkingMemory', arguments: '{"nested":{"a":99}}',
    };
    const result = await layer.hooks.store!({
      newItems: [funcCall], log: makeItemLog(),
      response: { items: [funcCall], usage: { inputTokens: 0, outputTokens: 0 } },
      ctx: makeCtx(), state: { nested: { a: 1, b: 2 } },
    });
    // Shallow merge: nested object is replaced entirely, b is lost
    expect((result as any).state.nested).toEqual({ a: 99 });
  });

  it('respects custom scope config', () => {
    const layer = workingMemory({ scope: 'resource' });
    expect(layer.scope).toBe('resource');
  });
});
