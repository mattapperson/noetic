import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { Channel } from '../../src/types/channel';
import type { MessageItem } from '../../src/types/items';
import { makeMockHarness } from '../_helpers';

function makeTestItem(): MessageItem {
  return {
    id: 'item-1',
    status: 'completed',
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: 'hello',
      },
    ],
  };
}

describe('ContextImpl', () => {
  test('default creation: id exists, stepCount=0, tokens all 0, cost=0, parent null, depth 0', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(ctx.id).toBeTruthy();
    expect(typeof ctx.id).toBe('string');
    expect(ctx.stepCount).toBe(0);
    expect(ctx.tokens).toEqual({
      input: 0,
      output: 0,
      total: 0,
    });
    expect(ctx.cost).toBe(0);
    expect(ctx.parent).toBeNull();
    expect(ctx.depth).toBe(0);
  });

  test('mutable state: can set and read back state', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
      state: {
        count: 1,
      },
    });
    expect(ctx.state).toEqual({
      count: 1,
    });
    ctx.state = {
      count: 42,
    };
    expect(ctx.state).toEqual({
      count: 42,
    });
  });

  test('parent/depth tracking: child has depth=1', () => {
    const parent = new ContextImpl({
      harness: makeMockHarness(),
    });
    const child = new ContextImpl({
      harness: makeMockHarness(),
      parent,
    });
    expect(child.parent).toBe(parent);
    expect(child.depth).toBe(1);
  });

  test('token fields are mutable', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    ctx.tokens.input = 10;
    ctx.tokens.output = 5;
    ctx.tokens.total = 15;
    expect(ctx.tokens.input).toBe(10);
    expect(ctx.tokens.output).toBe(5);
    expect(ctx.tokens.total).toBe(15);
  });

  test('itemLog exists and can append items', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(ctx.itemLog.items).toEqual([]);
    const item = makeTestItem();
    ctx.itemLog.append(item);
    expect(ctx.itemLog.items).toHaveLength(1);
    expect(ctx.itemLog.items[0]).toBe(item);
  });

  test('channel methods throw when no channel store configured', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const fakeChannel = {
      name: 'test',
      schema: z.unknown(),
      mode: 'value' as const,
    } satisfies Channel<unknown>;
    expect(() => ctx.send(fakeChannel, 'val')).toThrow('No channel store configured');
    expect(() => ctx.tryRecv(fakeChannel)).toThrow('No channel store configured');
    expect(ctx.recv(fakeChannel)).rejects.toThrow('No channel store configured');
  });

  test('lastStepMeta starts null, can be set', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(ctx.lastStepMeta).toBeNull();
    ctx.lastStepMeta = {
      cost: 0.01,
    };
    expect(ctx.lastStepMeta).toEqual({
      cost: 0.01,
    });
  });

  test('threadId is generated if not provided, or uses provided value', () => {
    const ctx1 = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(ctx1.threadId).toBeTruthy();
    expect(typeof ctx1.threadId).toBe('string');

    const ctx2 = new ContextImpl({
      harness: makeMockHarness(),
      threadId: 'my-thread',
    });
    expect(ctx2.threadId).toBe('my-thread');
  });

  test('resourceId is undefined if not provided, or uses provided value', () => {
    const ctx1 = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(ctx1.resourceId).toBeUndefined();

    const ctx2 = new ContextImpl({
      harness: makeMockHarness(),
      resourceId: 'res-123',
    });
    expect(ctx2.resourceId).toBe('res-123');
  });

  test('elapsed increases over time', async () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    const t1 = ctx.elapsed;
    await new Promise((r) => setTimeout(r, 10));
    const t2 = ctx.elapsed;
    expect(t2).toBeGreaterThan(t1);
  });

  test('span has traceId and spanId', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(ctx.span.traceId).toBeTruthy();
    expect(ctx.span.spanId).toBeTruthy();
    expect(ctx.span.parentSpanId).toBeNull();
  });

  test('default state is empty object', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(ctx.state).toEqual({});
  });

  test('abort sets aborted flag and stores reason', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(ctx.aborted).toBe(false);
    expect(ctx.abortReason).toBeUndefined();
    ctx.abort('test reason');
    expect(ctx.aborted).toBe(true);
    expect(ctx.abortReason).toBe('test reason');
  });

  test('items can be provided at construction', () => {
    const item = makeTestItem();
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
      items: [
        item,
      ],
    });
    expect(ctx.itemLog.items).toHaveLength(1);
    expect(ctx.itemLog.items[0]).toBe(item);
  });

  test('checkpoint calls injected checkpointFn', async () => {
    let called = false;
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
      checkpointFn: async () => {
        called = true;
      },
    });
    await ctx.checkpoint();
    expect(called).toBe(true);
  });

  test('checkpoint is no-op when no checkpointFn provided', async () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    await ctx.checkpoint();
    // Should resolve without error
  });

  test('complete sets completed and completionValue', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(ctx.completed).toBe(false);
    expect(ctx.completionValue).toBeUndefined();
    ctx.complete('result-42');
    expect(ctx.completed).toBe(true);
    expect(ctx.completionValue).toBe('result-42');
  });
});
