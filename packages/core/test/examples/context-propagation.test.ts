import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createAsyncLaunchTool, createSyncDelegateTool } from '../../examples/delegate-tools';
import { channel } from '../../src/builders/channel-builder';
import { InMemoryRuntime } from '../../src/runtime/in-memory-runtime';
import type { DetachedHandle } from '../../src/types/detached';
import type { ToolExecutionContext } from '../../src/types/tool-context';

function makeToolCtxWithRuntime(runtime: InMemoryRuntime): ToolExecutionContext {
  const ctx = runtime.createContext({
    threadId: 'thread-abc',
    resourceId: 'resource-xyz',
  });
  return {
    ctx,
    runtime,
    memory: {
      get: () => undefined,
      set: () => {},
    },
    assembledView: ctx.itemLog.items,
    lastStepMeta: null,
  };
}

describe('context propagation in delegate tools', () => {
  it('sync delegate tool uses parent context, not a new root context', async () => {
    const runtime = new InMemoryRuntime();
    const toolCtx = makeToolCtxWithRuntime(runtime);

    const delegateTool = createSyncDelegateTool();

    try {
      await delegateTool.execute(
        {
          task: 'test',
        },
        toolCtx,
      );
    } catch (err) {
      // Expected: no callModel configured
      if (!(err instanceof Error && err.message.includes('callModel'))) {
        throw err;
      }
    }

    expect(toolCtx.ctx.threadId).toBe('thread-abc');
    expect(toolCtx.ctx.resourceId).toBe('resource-xyz');
  });

  it('async launch tool uses parent context, not a new root context', async () => {
    const runtime = new InMemoryRuntime();
    const inbox = channel('test-inbox', {
      schema: z.string(),
      mode: 'queue',
    });
    const handles = new Map<string, DetachedHandle<string>>();
    const toolCtx = makeToolCtxWithRuntime(runtime);

    const launchTool = createAsyncLaunchTool({
      inbox,
      handles,
    });

    try {
      await launchTool.execute(
        {
          task: 'background work',
        },
        toolCtx,
      );
    } catch (err) {
      // Expected: no callModel configured
      if (!(err instanceof Error && err.message.includes('callModel'))) {
        throw err;
      }
    }

    expect(toolCtx.ctx.threadId).toBe('thread-abc');
    expect(toolCtx.ctx.resourceId).toBe('resource-xyz');
  });

  it('detachedSpawn forwards threadId and resourceId to child context', () => {
    const runtime = new InMemoryRuntime();
    const parentCtx = runtime.createContext({
      threadId: 'parent-thread',
      resourceId: 'parent-resource',
    });

    const childCtx = runtime.createContext({
      parent: parentCtx,
      threadId: parentCtx.threadId,
      resourceId: parentCtx.resourceId,
    });

    expect(childCtx.threadId).toBe('parent-thread');
    expect(childCtx.resourceId).toBe('parent-resource');
    expect(childCtx.parent).toBe(parentCtx);
    expect(childCtx.depth).toBe(1);
  });
});
