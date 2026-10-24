import { describe, expect, it, spyOn } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type { Context, Span, Step } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { channel } from '../../src/builders/channel-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { NoeticEvent } from '../../src/observability/genai-attributes';
import { SpanImpl } from '../../src/observability/span-impl';
import { InMemoryExporter } from '../../src/observability/trace-exporter';

const inbox = channel('warn-inbox', {
  schema: z.number(),
  mode: 'queue',
  capacity: 1,
  external: true,
});

/** A step that overflows `inbox` through an external handle while it runs. */
function overflowingStep(
  harness: AgentHarness,
  executionId: string,
): Step<ContextData, string, string> {
  return {
    kind: 'runCode',
    id: 'overflow',
    execute: async (input: string) => {
      const handle = harness.getChannelHandle(inbox, executionId);
      handle.send(1);
      handle.send(2);
      return input;
    },
  };
}

/** Install a traced span on a root context, the way `parseAndRunWorkflow` does. */
function installSpan(ctx: Context): SpanImpl {
  const span = new SpanImpl('root', null);
  frameworkCast<{
    span: Span;
  }>(ctx).span = span;
  return span;
}

describe('AgentHarness channel warnings', () => {
  it('records an overflow as a channel.warning event on the live root span', async () => {
    const warnSpy = spyOn(console, 'warn');
    const harness = new AgentHarness({
      name: 'test',
      params: {},
      traceExporter: new InMemoryExporter(),
    });
    const ctx = harness.createContext();
    const span = installSpan(ctx);

    await harness.run(overflowingStep(harness, ctx.id), 'go', ctx);

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    const event = span.events.find((e) => e.name === NoeticEvent.CHANNEL_WARNING);
    assert(event?.attributes);
    expect(event.attributes.kind).toBe('overflow_drop');
    expect(event.attributes.channelName).toBe('warn-inbox');
    expect(event.attributes.capacity).toBe(1);
    expect(ctx.itemLog.items).toEqual([]);
  });

  it('falls back to the console when no root is running', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const harness = new AgentHarness({
      name: 'test',
      params: {},
      traceExporter: new InMemoryExporter(),
    });
    const handle = harness.getChannelHandle(inbox, 'idle-exec');
    handle.send(1);
    handle.send(2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('dropping oldest');
    warnSpy.mockRestore();
  });

  it('falls back to the console when the live root span is not traced', async () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const ctx = harness.createContext();
    const span = installSpan(ctx);

    await harness.run(overflowingStep(harness, ctx.id), 'go', ctx);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
    expect(span.events).toEqual([]);
    expect(ctx.itemLog.items).toEqual([]);
  });
});
