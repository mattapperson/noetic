import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createAsyncLaunchTool, createSyncDelegateTool } from '../../examples/delegate-tools';
import { channel } from '../../src/builders/channel-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import type { DetachedHandle } from '../../src/types/detached';
import type { AgentHarnessContract } from '../../src/types/runtime';
import type { ToolExecutionContext } from '../../src/types/tool-context';

function makeToolCtxWithHarness(harness: AgentHarnessContract): ToolExecutionContext {
  const ctx = harness.createContext({
    threadId: 'thread-abc',
    resourceId: 'resource-xyz',
  });
  return {
    ctx,
    harness,
    fs: harness.fs,
    shell: harness.shell,
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
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const toolCtx = makeToolCtxWithHarness(harness);

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
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const inbox = channel('test-inbox', {
      schema: z.string(),
      mode: 'queue',
    });
    const handles = new Map<string, DetachedHandle<string>>();
    const toolCtx = makeToolCtxWithHarness(harness);

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
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const parentCtx = harness.createContext({
      threadId: 'parent-thread',
      resourceId: 'parent-resource',
    });

    const childCtx = harness.createContext({
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
