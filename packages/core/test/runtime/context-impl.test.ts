import { describe, expect, test } from 'bun:test';
import type { Channel, InputMessageItem } from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { ChannelStore } from '../../src/runtime/channel-store';
import { ContextImpl, collectContextTree } from '../../src/runtime/context-impl';
import { ItemLogImpl } from '../../src/runtime/item-log-impl';
import { makeMockContext, makeMockHarness } from '../_helpers';

function makeTestItem(): InputMessageItem {
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
    expect(ctx.send(fakeChannel, 'val')).rejects.toThrow('No channel store configured');
    expect(() => ctx.tryRecv(fakeChannel)).toThrow('No channel store configured');
    expect(ctx.recv(fakeChannel)).rejects.toThrow('No channel store configured');
  });

  test('ctx.abort() rejects a pending ctx.recv with kind cancelled (timeout 0)', async () => {
    const store = new ChannelStore();
    const ch = {
      name: 'abort-recv',
      schema: z.string(),
      mode: 'queue' as const,
    } satisfies Channel<string>;
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
      channelStore: store,
    });
    const pending = ctx.recv(ch, {
      timeout: 0,
    });
    ctx.abort('cleanup');
    try {
      await pending;
      throw new Error('should have rejected');
    } catch (e) {
      if (!isNoeticError(e)) {
        throw e;
      }
      const oe = e.noeticError;
      if (oe.kind !== 'cancelled') {
        throw new Error(`expected cancelled, got ${oe.kind}`);
      }
      expect(oe.reason).toBe('cleanup');
    }
  });

  test("aborting one context does not reject a sibling context's recv on the shared store", async () => {
    const store = new ChannelStore();
    const ch = {
      name: 'sibling-recv',
      schema: z.string(),
      mode: 'queue' as const,
    } satisfies Channel<string>;
    const harness = makeMockHarness();
    const abortedCtx = new ContextImpl({
      harness,
      channelStore: store,
    });
    const survivorCtx = new ContextImpl({
      harness,
      channelStore: store,
    });
    const abortedRecv = abortedCtx.recv(ch, {
      timeout: 1_000,
    });
    const survivorRecv = survivorCtx.recv(ch, {
      timeout: 1_000,
    });
    abortedCtx.abort('one down');
    await expect(abortedRecv).rejects.toThrow('Cancelled');
    store.send(ch, 'delivered');
    expect(await survivorRecv).toBe('delivered');
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

describe('ContextImpl abort cascade', () => {
  test('aborting a parent aborts its children and grandchildren with the same reason', () => {
    const harness = makeMockHarness();
    const root = new ContextImpl({
      harness,
    });
    const child = new ContextImpl({
      harness,
      parent: root,
    });
    const grandchild = new ContextImpl({
      harness,
      parent: child,
    });

    root.abort('user pressed stop');

    expect(child.aborted).toBe(true);
    expect(child.abortReason).toBe('user pressed stop');
    expect(grandchild.aborted).toBe(true);
    expect(grandchild.abortReason).toBe('user pressed stop');
  });

  test('a cascade with no reason gives children a parent-attributed reason', () => {
    const harness = makeMockHarness();
    const root = new ContextImpl({
      harness,
    });
    const child = new ContextImpl({
      harness,
      parent: root,
    });

    root.abort();

    expect(root.abortReason).toBeUndefined();
    expect(child.abortReason).toBe('parent context aborted');
  });

  test('aborting a child never aborts its parent or siblings', () => {
    const harness = makeMockHarness();
    const root = new ContextImpl({
      harness,
    });
    const first = new ContextImpl({
      harness,
      parent: root,
    });
    const second = new ContextImpl({
      harness,
      parent: root,
    });

    first.abort('path failed');

    expect(first.aborted).toBe(true);
    expect(root.aborted).toBe(false);
    expect(second.aborted).toBe(false);
  });

  test('a child constructed under an already-aborted parent is aborted immediately', () => {
    const harness = makeMockHarness();
    const root = new ContextImpl({
      harness,
    });
    root.abort('too late');

    const child = new ContextImpl({
      harness,
      parent: root,
    });

    expect(child.aborted).toBe(true);
    expect(child.abortReason).toBe('too late');
    // Registering is pointless once aborted — the child is not retained.
    expect(root.children).toHaveLength(0);
  });

  test('a detached child is no longer reached by the cascade', () => {
    const harness = makeMockHarness();
    const root = new ContextImpl({
      harness,
    });
    const child = new ContextImpl({
      harness,
      parent: root,
    });
    expect(root.children).toEqual([
      child,
    ]);

    child.detachFromParent();
    expect(root.children).toHaveLength(0);
    root.abort('done');

    expect(child.aborted).toBe(false);
  });

  test('the first abort owns the reason; later aborts are no-ops', () => {
    const harness = makeMockHarness();
    const root = new ContextImpl({
      harness,
    });
    root.abort('first');
    root.abort('second');
    expect(root.abortReason).toBe('first');

    const late = new ContextImpl({
      harness,
      parent: root,
    });
    expect(late.abortReason).toBe('first');
  });

  test("aborting a parent rejects a child's pending recv with kind cancelled", async () => {
    const harness = makeMockHarness();
    const store = new ChannelStore();
    const ch = {
      name: 'cascade-recv',
      schema: z.string(),
      mode: 'queue' as const,
    } satisfies Channel<string>;
    const root = new ContextImpl({
      harness,
      channelStore: store,
    });
    const child = new ContextImpl({
      harness,
      parent: root,
      channelStore: store,
    });
    const pending = child.recv(ch, {
      timeout: 5_000,
    });

    root.abort('parent gone');

    try {
      await pending;
      throw new Error('should have rejected');
    } catch (e) {
      if (!isNoeticError(e)) {
        throw e;
      }
      expect(e.noeticError.kind).toBe('cancelled');
      if (e.noeticError.kind !== 'cancelled') {
        throw e;
      }
      expect(e.noeticError.reason).toBe('parent gone');
    }
  });
});

describe('collectContextTree', () => {
  test('returns the subtree in pre-order, parents before children', () => {
    const harness = makeMockHarness();
    const root = new ContextImpl({
      harness,
    });
    const first = new ContextImpl({
      harness,
      parent: root,
    });
    const firstChild = new ContextImpl({
      harness,
      parent: first,
    });
    const second = new ContextImpl({
      harness,
      parent: root,
    });

    expect(collectContextTree(root)).toEqual([
      root,
      first,
      firstChild,
      second,
    ]);
    // Reversed, it is the deepest-first cleanup order.
    expect(collectContextTree(root).reverse()[0]).toBe(second);
  });

  test('a foreign Context implementation yields only itself', () => {
    const foreign = makeMockContext();
    expect(collectContextTree(foreign)).toEqual([
      foreign,
    ]);
  });
});

describe('ContextImpl shared itemLog option', () => {
  /**
   * The session runner hands every turn's context the ONE session-owned log.
   * Appending through the context must land on the shared instance, and reads
   * through either handle must observe the other's writes — that identity is
   * what replaces the old copy-forward/copy-back history.
   */
  test('a context constructed with `itemLog` shares the instance by reference', () => {
    const shared = new ItemLogImpl();
    shared.append(makeTestItem());
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
      itemLog: shared,
    });

    expect(ctx.itemLog).toBe(shared);
    expect(ctx.itemLog.items).toHaveLength(1);

    // Writes through the context land on the shared log...
    ctx.itemLog.append({
      ...makeTestItem(),
      id: 'item-2',
    });
    expect(shared.items).toHaveLength(2);

    // ...and a rollback through the shared handle is visible to the context.
    shared.truncateTo(1);
    expect(ctx.itemLog.items).toHaveLength(1);
  });

  test('without `itemLog`, a context still builds its own log from `items`', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
      items: [
        makeTestItem(),
      ],
    });
    expect(ctx.itemLog.items).toHaveLength(1);
    // Mutating the context's log must not reach into any other instance.
    const other = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(other.itemLog.items).toHaveLength(0);
  });
});
