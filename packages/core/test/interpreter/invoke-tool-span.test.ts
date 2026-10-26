import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { AgentHarnessContract, StepInvokeTool } from '@noetic-tools/types';
import { SteeringAction } from '@noetic-tools/types';
import { z } from 'zod';
import { execute } from '../../src/interpreter/execute';
import { NoeticAttr, ToolAttr } from '../../src/observability/genai-attributes';
import { SpanImpl } from '../../src/observability/span-impl';
import { InMemoryExporter } from '../../src/observability/trace-exporter';
import { ContextImpl } from '../../src/runtime/context-impl';
import { makeMockHarness } from '../_helpers';

function tracedContext(): {
  ctx: ContextImpl;
  root: SpanImpl;
  exporter: InMemoryExporter;
} {
  const exporter = new InMemoryExporter();
  const base = makeMockHarness();
  const harness: AgentHarnessContract = {
    ...base,
    config: {
      ...base.config,
      approveToolCall: () => ({
        action: SteeringAction.Allow,
      }),
    },
    traceExporter: exporter,
    createSpan: (name, parent) => new SpanImpl(name, parent),
  };
  const root = new SpanImpl('root', null);
  return {
    ctx: new ContextImpl({
      harness,
      span: root,
    }),
    root,
    exporter,
  };
}

function echoStep(
  execute: (args: { text: string }) => Promise<string>,
  needsApproval?: boolean,
): StepInvokeTool<
  Record<string, never>,
  {
    text: string;
  },
  string
> {
  return {
    kind: 'invokeTool',
    id: 'echo-step',
    tool: {
      name: 'echo',
      description: 'Echo the text',
      input: z.object({
        text: z.string(),
      }),
      output: z.string(),
      needsApproval,
      execute,
    },
  };
}

describe('invokeTool spans', () => {
  it('opens a tool.call span under ctx.span and exports it', async () => {
    const { ctx, root, exporter } = tracedContext();

    const result = await execute(
      echoStep(async ({ text }) => text, true),
      {
        text: 'hi',
      },
      ctx,
    );

    expect(result).toBe('hi');
    const [span] = exporter.getSpansByName('tool.call');
    assert(span);
    expect(span.parentSpanId).toBe(root.spanId);
    expect(span.endTime).toBeDefined();
    expect(span.attributes.get(ToolAttr.NAME)).toBe('echo');
    expect(span.attributes.get(ToolAttr.NEEDS_APPROVAL)).toBe(true);
    expect(span.attributes.get(ToolAttr.APPROVAL)).toBe('approved');
    expect(span.attributes.get(NoeticAttr.NODE_ID)).toBe('echo-step');
    expect(span.attributes.has('error')).toBe(false);
  });

  it('marks the span failed when the tool throws', async () => {
    const { ctx, exporter } = tracedContext();

    await expect(
      execute(
        echoStep(async () => {
          throw new Error('boom');
        }),
        {
          text: 'hi',
        },
        ctx,
      ),
    ).rejects.toThrow();

    const [span] = exporter.getSpansByName('tool.call');
    assert(span);
    expect(span.attributes.get(ToolAttr.NEEDS_APPROVAL)).toBe(false);
    expect(span.attributes.has(ToolAttr.APPROVAL)).toBe(false);
    expect(span.attributes.get(NoeticAttr.ERROR_KIND)).toBe('step_failed');
    expect(span.attributes.get('error')).toBe(true);
  });
});
