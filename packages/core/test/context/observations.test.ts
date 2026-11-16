import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ObservationsState } from '@noetic-tools/context';
import { observations } from '@noetic-tools/context';
import type { MessageItem } from '@noetic-tools/types';
import { makeCtx, makeItemLog, makeScopedStorage } from '../_helpers';

describe('observations', () => {
  it('has correct id and slot', () => {
    const layer = observations();
    expect(layer.id).toBe('observations');
    expect(layer.slot).toBe(200);
  });

  it('init loads state from storage', async () => {
    const layer = observations();
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
    const layer = observations();
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
    const layer = observations({
      bufferThreshold: 5,
    });
    const state: ObservationsState = {
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
    const layer = observations();
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

describe('observations deferred distillation (M8, redesigned)', () => {
  function assistantItem(text: string): MessageItem {
    return {
      id: 'a1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text,
        },
      ],
    };
  }

  const emptyResponse = {
    items: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
    },
  };

  it('declares no LLM-headroom timeouts — distillation runs off the turn path', () => {
    const layer = observations();
    // The observer is fire-and-collect now: hooks only append to the buffer,
    // so the default hook timeouts are sufficient and the turn never blocks
    // on an LLM distillation call.
    expect('timeouts' in layer).toBe(false);
  });

  it('crossing the threshold with an observer clears the buffer without blocking', async () => {
    let resolveObserver: ((v: string[]) => void) | undefined;
    const layer = observations({
      bufferThreshold: 1,
      observer: () =>
        new Promise<string[]>((resolve) => {
          resolveObserver = resolve;
        }),
    });
    const ctx = makeCtx();
    const result = await layer.hooks.store!({
      newItems: [
        assistantItem('a long enough assistant answer to cross the threshold'),
      ],
      log: makeItemLog(),
      response: emptyResponse,
      ctx,
      state: {
        observations: [],
        buffer: [],
        bufferTokens: 0,
        version: 0,
      },
    });
    assert(result !== undefined);
    // Returned without awaiting the observer; the batch is in flight.
    expect(result.state.buffer).toEqual([]);
    expect(result.state.observations).toEqual([]);

    // ...and the observation lands on a later hook once the observer resolves.
    assert(resolveObserver);
    resolveObserver([
      'deferred fact',
    ]);
    await Bun.sleep(1);

    const drained = await layer.hooks.store!({
      newItems: [],
      log: makeItemLog(),
      response: emptyResponse,
      ctx,
      state: result.state,
    });
    assert(drained !== undefined);
    expect(drained.state.observations).toEqual([
      'deferred fact',
    ]);
    // The drain bumps version so downstream churn tracking sees the change.
    expect(drained.state.version).toBe(result.state.version + 1);
  });

  it('a failed distillation retains its batch and retries on a later hook', async () => {
    // The blocking path kept the buffer on observer failure; the deferred path
    // must not silently drop the batch either. A rejected batch drains back
    // into the buffer, which re-crosses the threshold and retries.
    let calls = 0;
    const layer = observations({
      bufferThreshold: 1,
      observer: () =>
        ++calls === 1
          ? Promise.reject(new Error('observer exploded'))
          : Promise.resolve([
              'recovered fact',
            ]),
    });
    const ctx = makeCtx();
    const emptyState = {
      observations: [],
      buffer: [],
      bufferTokens: 0,
      version: 0,
    };
    const storeOnce = (state: ObservationsState) =>
      layer.hooks.store!({
        newItems: [
          assistantItem('enough text to cross the tiny threshold'),
        ],
        log: makeItemLog(),
        response: emptyResponse,
        ctx,
        state,
      });

    const first = await storeOnce(emptyState);
    assert(first !== undefined);
    expect(first.state.buffer).toEqual([]);
    await Bun.sleep(1);
    expect(calls).toBe(1);

    // The failed batch drains back into the buffer and immediately retries.
    const second = await storeOnce(first.state);
    assert(second !== undefined);
    await Bun.sleep(1);
    expect(calls).toBe(2);

    const third = await storeOnce(second.state);
    assert(third !== undefined);
    expect(third.state.observations).toEqual([
      'recovered fact',
    ]);
  });

  it('keeps deferred batches keyed per scope so resources cannot cross-contaminate', async () => {
    // One layer instance is shared across every resource on a harness, while
    // its state is stored per scope key. A single shared bucket would drain
    // resource A's distillation into resource B's observations.
    let resolveA: ((v: string[]) => void) | undefined;
    const layer = observations({
      bufferThreshold: 1,
      observer: () =>
        new Promise<string[]>((resolve) => {
          resolveA = resolve;
        }),
    });
    const ctxA = makeCtx({
      resourceId: 'user-a',
    });
    const ctxB = makeCtx({
      resourceId: 'user-b',
    });
    const emptyState = {
      observations: [],
      buffer: [],
      bufferTokens: 0,
      version: 0,
    };

    const a1 = await layer.hooks.store!({
      newItems: [
        assistantItem('resource A text long enough to cross the threshold'),
      ],
      log: makeItemLog(),
      response: emptyResponse,
      ctx: ctxA,
      state: emptyState,
    });
    assert(a1 !== undefined);
    assert(resolveA);
    resolveA([
      'A-only fact',
    ]);
    await Bun.sleep(1);

    // B drains its own (empty) bucket — A's batch must not appear here.
    const b1 = await layer.hooks.store!({
      newItems: [],
      log: makeItemLog(),
      response: emptyResponse,
      ctx: ctxB,
      state: emptyState,
    });
    assert(b1 !== undefined);
    expect(b1.state.observations).toEqual([]);

    // A still gets it.
    const a2 = await layer.hooks.store!({
      newItems: [],
      log: makeItemLog(),
      response: emptyResponse,
      ctx: ctxA,
      state: a1.state,
    });
    assert(a2 !== undefined);
    expect(a2.state.observations).toEqual([
      'A-only fact',
    ]);
  });

  it('recall never mutates state, so a drained batch cannot demote the anchor band', async () => {
    // Draining in store/onItemAppend keeps recall pure: `state` is absent from
    // recall's return type, so the lifecycle can never see it as mutated here.
    const layer = observations();
    const state = {
      observations: [
        'known fact',
      ],
      buffer: [],
      bufferTokens: 0,
      version: 1,
    };
    const recall = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx: makeCtx(),
      state,
      budget: 1_000,
    });
    assert(recall !== null && typeof recall !== 'string');
    expect(Object.hasOwn(recall, 'state')).toBe(false);
    expect(recall.items.length).toBe(1);
  });
});
