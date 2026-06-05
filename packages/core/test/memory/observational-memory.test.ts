import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ObservationalState } from '@noetic-tools/memory';
import { observationalMemory } from '@noetic-tools/memory';
import type { MessageItem } from '@noetic-tools/types';
import { makeCtx, makeItemLog, makeScopedStorage } from '../_helpers';

describe('observationalMemory', () => {
  it('has correct id and slot', () => {
    const layer = observationalMemory();
    expect(layer.id).toBe('observational-memory');
    expect(layer.slot).toBe(200);
  });

  it('init loads state from storage', async () => {
    const layer = observationalMemory();
    const result = await layer.hooks.init!({
      storage: makeScopedStorage(),
      scopeKey: 'user-1',
      ctx: makeCtx(),
    });
    expect(result.state).toEqual({
      observations: [],
      buffer: [],
      bufferTokens: 0,
      version: 0,
    });
  });

  it('recall renders observations', async () => {
    const layer = observationalMemory();
    const state = {
      observations: [
        'Tool X returns errors',
        'User prefers JSON',
      ],
      buffer: [],
      bufferTokens: 0,
      version: 1,
    };
    const result = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx: makeCtx(),
      state,
      budget: 1_000,
    });
    expect(result).not.toBeNull();
    assert(typeof result !== 'string');
    const msg = result!.items[0];
    assert(msg.type === 'message');
    const part = msg.content[0];
    assert(part.type === 'input_text');
    expect(part.text).toContain('Tool X returns errors');
  });

  it('store accumulates and compresses at threshold', async () => {
    // Token-based threshold: "test output" ≈ 3 tokens, so threshold 5 triggers after 2 items
    const layer = observationalMemory({
      bufferThreshold: 5,
    });
    const state: ObservationalState = {
      observations: [],
      buffer: [],
      bufferTokens: 0,
      version: 0,
    };
    const msg: MessageItem = {
      id: '1',
      status: 'completed',
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: 'test output',
        },
      ],
    };

    // First store: buffer grows
    const r1 = await layer.hooks.store!({
      newItems: [
        msg,
      ],
      log: makeItemLog(),
      response: {
        items: [
          msg,
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      ctx: makeCtx(),
      state,
    });
    assert(r1 !== undefined);
    expect(r1.state.buffer).toHaveLength(1);

    // Second store: threshold reached, compresses
    const r2 = await layer.hooks.store!({
      newItems: [
        msg,
      ],
      log: makeItemLog(),
      response: {
        items: [
          msg,
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      ctx: makeCtx(),
      state: r1.state,
    });
    assert(r2 !== undefined);
    expect(r2.state.observations).toHaveLength(1);
    expect(r2.state.observations[0]).toContain('Processed 2 items');
    expect(r2.state.buffer).toHaveLength(0);
  });

  it('onSpawn clones state', async () => {
    const layer = observationalMemory();
    const parentState = {
      observations: [
        'obs1',
      ],
      buffer: [
        'buf1',
      ],
      bufferTokens: 1,
      version: 1,
    };
    const result = await layer.hooks.onSpawn!({
      parentState,
      childCtx: makeCtx(),
    });
    expect(result!.childState).toEqual(parentState);
    expect(result!.childState).not.toBe(parentState);
  });
});
