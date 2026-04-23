/**
 * sendMessage round-trip: verifies the message lands in the registry queue
 * AND is drained by `teammateInboundLayer` on the child's next recall.
 */

import { describe, expect, test } from 'bun:test';
import type { DetachedHandle, ExecutionContext, Item, ItemLog } from '@noetic/core';
import { createLocalFsAdapter, createLocalShellAdapter } from '@noetic/core';
import { TeammateRegistry } from '../src/agents/registry-runtime.js';
import { teammateInboundLayer } from '../src/memory/teammate-inbound-layer.js';

function makeFakeHandle(id: string): DetachedHandle<string> {
  return {
    id,
    status: 'running',
    result: undefined,
    error: undefined,
    await: () => new Promise(() => undefined),
  };
}

function makeCtx(): ExecutionContext {
  return {
    executionId: 'exec-1',
    threadId: 'teammate-x',
    depth: 1,
    stepNumber: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    cost: 0,
    fs: createLocalFsAdapter(),
    shell: createLocalShellAdapter(),
    tokenize: (text: string) => text.length,
    trace: {
      setAttribute() {},
      addEvent() {},
    },
    readLayerState: <T>(_id: string): T | undefined => undefined,
  };
}

function makeLog(): ItemLog {
  const items: Item[] = [];
  return {
    get items(): ReadonlyArray<Item> {
      return items;
    },
    append(item: Item): void {
      items.push(item);
    },
  };
}

interface RecallArgs {
  ctx: ExecutionContext;
  state: null;
  log: ItemLog;
  query: string;
  budget: number;
}

function recallArgs(): RecallArgs {
  return {
    ctx: makeCtx(),
    state: null,
    log: makeLog(),
    query: '',
    budget: 10_000,
  };
}

describe('sendMessage → inbound-layer round-trip', () => {
  test('postInbound lands in the registry queue and drains as <inbound-message> items', async () => {
    const registry = new TeammateRegistry();
    registry.registerByName('researcher', {
      handle: makeFakeHandle('researcher-1'),
      inbox: [],
    });

    // Simulate what the sendMessage tool does.
    expect(registry.postInbound('researcher', 'find 3 examples')).toBe(true);
    expect(registry.postInbound('researcher', 'then summarize')).toBe(true);

    const layer = teammateInboundLayer({
      teammates: registry,
      name: 'researcher',
    });
    const result = await layer.hooks.recall?.(recallArgs());

    expect(result).not.toBeNull();
    if (!result || typeof result === 'string') {
      throw new Error('expected RecallResult');
    }
    expect(result.items).toHaveLength(2);

    const text0 = JSON.stringify(result.items[0]);
    expect(text0).toContain('<inbound-message>');
    expect(text0).toContain('find 3 examples');

    const text1 = JSON.stringify(result.items[1]);
    expect(text1).toContain('then summarize');
  });

  test('second recall returns null — queue is drained', async () => {
    const registry = new TeammateRegistry();
    registry.registerByName('r', {
      handle: makeFakeHandle('r-1'),
      inbox: [],
    });
    registry.postInbound('r', 'one');

    const layer = teammateInboundLayer({
      teammates: registry,
      name: 'r',
    });
    const first = await layer.hooks.recall?.(recallArgs());
    expect(first).not.toBeNull();

    const second = await layer.hooks.recall?.(recallArgs());
    expect(second).toBeNull();
  });

  test('postInbound to an unknown teammate returns false and does not leak items', async () => {
    const registry = new TeammateRegistry();
    expect(registry.postInbound('ghost', 'hi')).toBe(false);

    const layer = teammateInboundLayer({
      teammates: registry,
      name: 'ghost',
    });
    const result = await layer.hooks.recall?.(recallArgs());
    expect(result).toBeNull();
  });
});
