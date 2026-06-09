import { describe, expect, test } from 'bun:test';
import type { ExecutionContext, Item, ItemLog } from '@noetic-tools/core';
import { createLocalFsAdapter, createLocalShellAdapter } from '@noetic-tools/platform-node';
import { TeammateRegistry } from '../src/agents/registry-runtime.js';
import { teammateInboxLayer } from '../src/memory/teammate-inbox-layer.js';

function makeCtx(): ExecutionContext {
  return {
    executionId: 'exec-1',
    threadId: 'thread-1',
    depth: 0,
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

function makeRecallArgs(): RecallArgs {
  return {
    ctx: makeCtx(),
    state: null,
    log: makeLog(),
    query: '',
    budget: 1_000,
  };
}

describe('teammateInboxLayer', () => {
  test('returns null when registry has no pending notices', async () => {
    const registry = new TeammateRegistry();
    const layer = teammateInboxLayer({
      teammates: registry,
    });
    const result = await layer.hooks.recall?.(makeRecallArgs());
    expect(result).toBeNull();
  });

  test('drains queued notices into developer-message items wrapped in <task-notification>', async () => {
    const registry = new TeammateRegistry();
    registry.postNotice('[teammate explore-1 completed] found 3 results');
    registry.postNotice('[teammate plan-2 failed] timeout');

    const layer = teammateInboxLayer({
      teammates: registry,
    });
    const result = await layer.hooks.recall?.(makeRecallArgs());
    expect(result).not.toBeNull();
    if (!result || typeof result === 'string') {
      throw new Error('expected RecallResult, got null or string');
    }
    expect(result.items).toHaveLength(2);
    const text0 = JSON.stringify(result.items[0]);
    expect(text0).toContain('<task-notification>');
    expect(text0).toContain('explore-1 completed');
  });

  test('drains the queue (subsequent recall returns null)', async () => {
    const registry = new TeammateRegistry();
    registry.postNotice('only-one');

    const layer = teammateInboxLayer({
      teammates: registry,
    });
    const first = await layer.hooks.recall?.(makeRecallArgs());
    expect(first).not.toBeNull();

    const second = await layer.hooks.recall?.(makeRecallArgs());
    expect(second).toBeNull();
  });
});
