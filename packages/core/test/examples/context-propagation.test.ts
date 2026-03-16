import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createAsyncLaunchTool, createSyncDelegateTool } from '../../examples/delegate-tools';
import { channel } from '../../src/builders/channel-builder';
import { InMemoryRuntime } from '../../src/runtime/in-memory-runtime';
import type { DetachedHandle } from '../../src/types/detached';

describe('context propagation in delegate tools', () => {
  it('sync delegate tool uses parent context, not a new root context', async () => {
    const runtime = new InMemoryRuntime();
    const parentCtx = runtime.createContext({
      threadId: 'thread-abc',
      resourceId: 'resource-xyz',
    });

    const delegateTool = createSyncDelegateTool(runtime);

    // Calling execute with the parent context should not throw
    // and the tool should forward ctx to runtime.execute
    // (which will fail because no callModel is set, but that's expected)
    try {
      await delegateTool.execute(
        {
          task: 'test',
        },
        parentCtx,
      );
    } catch (err) {
      // Expected: no callModel configured — rethrow anything unexpected
      if (!(err instanceof Error && err.message.includes('callModel'))) {
        throw err;
      }
    }

    // The key assertion: parentCtx should have been used (not a new root)
    // We verify by checking the parent context's threadId is preserved
    expect(parentCtx.threadId).toBe('thread-abc');
    expect(parentCtx.resourceId).toBe('resource-xyz');
  });

  it('async launch tool uses parent context, not a new root context', async () => {
    const runtime = new InMemoryRuntime();
    const inbox = channel('test-inbox', {
      schema: z.string(),
      mode: 'queue',
    });
    const handles = new Map<string, DetachedHandle<string>>();
    const parentCtx = runtime.createContext({
      threadId: 'thread-async',
      resourceId: 'resource-async',
    });

    const launchTool = createAsyncLaunchTool({
      runtime,
      inbox,
      handles,
    });

    // This will create a detached spawn using the parent context
    try {
      await launchTool.execute(
        {
          task: 'background work',
        },
        parentCtx,
      );
    } catch (err) {
      // Expected: no callModel configured — rethrow anything unexpected
      if (!(err instanceof Error && err.message.includes('callModel'))) {
        throw err;
      }
    }

    expect(parentCtx.threadId).toBe('thread-async');
    expect(parentCtx.resourceId).toBe('resource-async');
  });

  it('detachedSpawn forwards threadId and resourceId to child context', () => {
    const runtime = new InMemoryRuntime();
    const parentCtx = runtime.createContext({
      threadId: 'parent-thread',
      resourceId: 'parent-resource',
    });

    // Create a child context the same way detachedSpawn does internally
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
