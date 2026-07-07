import { describe, expect, it } from 'bun:test';
import type { ContextMemory } from '@noetic-tools/memory';
import type { Context, StepTool, StreamEvent, Tool } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { emitToolUi } from '../../src/harness/tool-ui';
import { executeTool } from '../../src/interpreter/execute-action';
import { makeMockContext, makeMockHarness } from '../_helpers';

/** A recording broadcaster satisfying the `_broadcaster` structural check. */
function recordingBroadcaster(): {
  events: StreamEvent[];
  emit(event: StreamEvent): void;
} {
  const events: StreamEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
  };
}

/** A mock context with a recording broadcaster attached. */
function ctxWithBroadcaster() {
  const broadcaster = recordingBroadcaster();
  const base = makeMockContext({
    harness: makeMockHarness(),
  });
  const ctx = frameworkCast<Context>({
    ...base,
    _broadcaster: broadcaster,
  });
  return {
    ctx,
    broadcaster,
    harness: base.harness,
  };
}

const FRAG = {
  dialect: 'openui-lang/0.5',
  source: 'root = Card("Hi")',
};

describe('emitToolUi', () => {
  it('emits an openui.fragment framework event when the phase renders one', () => {
    const { ctx, broadcaster } = ctxWithBroadcaster();
    const tool = frameworkCast<Tool>({
      name: 't',
      ui: {
        call: () => FRAG,
      },
    });
    emitToolUi({
      ctx,
      tool,
      callId: 'c1',
      phase: 'call',
      args: {},
    });
    expect(broadcaster.events).toHaveLength(1);
    const event = broadcaster.events[0];
    expect(event?.source).toBe('framework');
    expect(event?.type).toBe('test-harness:openui.fragment');
    expect(event?.data).toEqual({
      callId: 'c1',
      dialect: FRAG.dialect,
      source: FRAG.source,
    });
  });

  it('is a no-op when the tool declares no ui, or the phase method returns null', () => {
    const { ctx, broadcaster } = ctxWithBroadcaster();
    emitToolUi({
      ctx,
      tool: frameworkCast<Tool>({
        name: 'plain',
      }),
      callId: 'c',
      phase: 'call',
      args: {},
    });
    emitToolUi({
      ctx,
      tool: frameworkCast<Tool>({
        name: 'nullish',
        ui: {
          result: () => null,
        },
      }),
      callId: 'c',
      phase: 'result',
      args: {},
      output: {},
    });
    expect(broadcaster.events).toEqual([]);
  });

  it('selects the right method per phase', () => {
    const { ctx, broadcaster } = ctxWithBroadcaster();
    const tool = frameworkCast<Tool>({
      name: 't',
      ui: {
        call: () => ({
          dialect: 'd',
          source: 'call',
        }),
        progress: (events: unknown[]) => ({
          dialect: 'd',
          source: `progress:${events.length}`,
        }),
        result: () => ({
          dialect: 'd',
          source: 'result',
        }),
        error: () => ({
          dialect: 'd',
          source: 'error',
        }),
      },
    });
    emitToolUi({
      ctx,
      tool,
      callId: 'c',
      phase: 'call',
      args: {},
    });
    emitToolUi({
      ctx,
      tool,
      callId: 'c',
      phase: 'progress',
      args: {},
      events: [
        1,
        2,
      ],
    });
    emitToolUi({
      ctx,
      tool,
      callId: 'c',
      phase: 'result',
      args: {},
      output: {},
    });
    emitToolUi({
      ctx,
      tool,
      callId: 'c',
      phase: 'error',
      args: {},
      error: new Error('x'),
    });
    expect(broadcaster.events.map((e) => e.data.source)).toEqual([
      'call',
      'progress:2',
      'result',
      'error',
    ]);
  });
});

describe('executeTool tool-UI integration', () => {
  it('emits call then result fragments around a direct step.tool, keyed by step id', async () => {
    const { ctx, broadcaster, harness } = ctxWithBroadcaster();
    const tool: Tool = frameworkCast<Tool>({
      name: 'quote',
      description: 'quote',
      input: z.object({
        carrier: z.string(),
      }),
      output: z.object({
        price: z.number(),
      }),
      execute: async (args: { carrier: string }) => ({
        price: args.carrier === 'ups' ? 10 : 20,
      }),
      ui: {
        call: (args: { carrier?: string }) => ({
          dialect: 'openui-lang/0.5',
          source: `root = Text("quoting ${args.carrier}")`,
        }),
        result: (out: { price: number }) => ({
          dialect: 'openui-lang/0.5',
          source: `root = Text("$${out.price}")`,
        }),
      },
    });
    const step: StepTool<ContextMemory, unknown, unknown> = {
      kind: 'tool',
      id: 'quote-step',
      tool,
    };

    const result = await executeTool(
      step,
      {
        carrier: 'ups',
      },
      ctx,
      harness,
    );
    expect(result).toEqual({
      price: 10,
    });
    const fragments = broadcaster.events.filter((e) => e.type.endsWith('openui.fragment'));
    expect(fragments).toHaveLength(2);
    expect(fragments[0]?.data).toMatchObject({
      callId: 'quote-step',
      source: 'root = Text("quoting ups")',
    });
    expect(fragments[1]?.data).toMatchObject({
      callId: 'quote-step',
      source: 'root = Text("$10")',
    });
  });

  it('emits an error fragment when a direct step.tool throws', async () => {
    const { ctx, broadcaster, harness } = ctxWithBroadcaster();
    const tool = frameworkCast<Tool>({
      name: 'boom',
      description: 'boom',
      input: z.object({}),
      output: z.object({}),
      execute: async () => {
        throw new Error('kaboom');
      },
      ui: {
        error: (err: unknown) => ({
          dialect: 'openui-lang/0.5',
          source: `root = Text("${err instanceof Error ? err.message : 'err'}")`,
        }),
      },
    });
    const step: StepTool<ContextMemory, unknown, unknown> = {
      kind: 'tool',
      id: 'boom-step',
      tool,
    };
    await expect(executeTool(step, {}, ctx, harness)).rejects.toThrow();
    const fragments = broadcaster.events.filter((e) => e.type.endsWith('openui.fragment'));
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.data.source).toBe('root = Text("kaboom")');
  });
});
