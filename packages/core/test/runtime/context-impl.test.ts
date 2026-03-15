import { describe, test, expect } from 'bun:test';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { Channel } from '../../src/types/channel';
import type { Item, MessageItem } from '../../src/types/items';

function makeTestItem(): MessageItem {
  return {
    id: 'item-1',
    status: 'completed',
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'hello' }],
  };
}

describe('ContextImpl', () => {
  test('default creation: id exists, stepCount=0, tokens all 0, cost=0, parent null, depth 0', () => {
    const ctx = new ContextImpl();
    expect(ctx.id).toBeTruthy();
    expect(typeof ctx.id).toBe('string');
    expect(ctx.stepCount).toBe(0);
    expect(ctx.tokens).toEqual({ input: 0, output: 0, total: 0 });
    expect(ctx.cost).toBe(0);
    expect(ctx.parent).toBeNull();
    expect(ctx.depth).toBe(0);
  });

  test('mutable state: can set and read back state', () => {
    const ctx = new ContextImpl({ state: { count: 1 } });
    expect(ctx.state).toEqual({ count: 1 });
    ctx.state = { count: 42 };
    expect(ctx.state).toEqual({ count: 42 });
  });

  test('parent/depth tracking: child has depth=1', () => {
    const parent = new ContextImpl();
    const child = new ContextImpl({ parent });
    expect(child.parent).toBe(parent);
    expect(child.depth).toBe(1);
  });

  test('token accumulation: modify tokens, verify total updates', () => {
    const ctx = new ContextImpl();
    ctx.tokens.input = 10;
    ctx.tokens.output = 5;
    ctx.tokens.total = 15;
    expect(ctx.tokens.input).toBe(10);
    expect(ctx.tokens.output).toBe(5);
    expect(ctx.tokens.total).toBe(15);
  });

  test('itemLog exists and can append items', () => {
    const ctx = new ContextImpl();
    expect(ctx.itemLog.items).toEqual([]);
    const item = makeTestItem();
    ctx.itemLog.append(item);
    expect(ctx.itemLog.items).toHaveLength(1);
    expect(ctx.itemLog.items[0]).toBe(item);
  });

  test('channel methods throw "Not implemented"', () => {
    const ctx = new ContextImpl();
    const fakeChannel = {} as Channel<unknown>;
    expect(() => ctx.send(fakeChannel, 'val')).toThrow('Not implemented');
    expect(() => ctx.tryRecv(fakeChannel)).toThrow('Not implemented');
    expect(ctx.recv(fakeChannel)).rejects.toThrow('Not implemented');
  });

  test('lastStepMeta starts null, can be set', () => {
    const ctx = new ContextImpl();
    expect(ctx.lastStepMeta).toBeNull();
    (ctx as any).lastStepMeta = { cost: 0.01 };
    expect(ctx.lastStepMeta).toEqual({ cost: 0.01 });
  });

  test('threadId is generated if not provided, or uses provided value', () => {
    const ctx1 = new ContextImpl();
    expect(ctx1.threadId).toBeTruthy();
    expect(typeof ctx1.threadId).toBe('string');

    const ctx2 = new ContextImpl({ threadId: 'my-thread' });
    expect(ctx2.threadId).toBe('my-thread');
  });

  test('resourceId is undefined if not provided, or uses provided value', () => {
    const ctx1 = new ContextImpl();
    expect(ctx1.resourceId).toBeUndefined();

    const ctx2 = new ContextImpl({ resourceId: 'res-123' });
    expect(ctx2.resourceId).toBe('res-123');
  });

  test('elapsed increases over time', async () => {
    const ctx = new ContextImpl();
    const t1 = ctx.elapsed;
    await new Promise((r) => setTimeout(r, 10));
    const t2 = ctx.elapsed;
    expect(t2).toBeGreaterThan(t1);
  });

  test('span has traceId and spanId', () => {
    const ctx = new ContextImpl();
    expect(ctx.span.traceId).toBeTruthy();
    expect(ctx.span.spanId).toBeTruthy();
    expect(ctx.span.parentSpanId).toBeNull();
  });

  test('default state is empty object', () => {
    const ctx = new ContextImpl();
    expect(ctx.state).toEqual({});
  });

  test('checkpoint is a no-op async', async () => {
    const ctx = new ContextImpl();
    await expect(ctx.checkpoint()).resolves.toBeUndefined();
  });

  test('items can be provided at construction', () => {
    const item = makeTestItem();
    const ctx = new ContextImpl({ items: [item] });
    expect(ctx.itemLog.items).toHaveLength(1);
    expect(ctx.itemLog.items[0]).toBe(item);
  });
});
