import { describe, expect, it } from 'bun:test';
import type { LLMResponse } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { GenAI, ToolAttr } from '../../src/observability/genai-attributes';
import { InMemoryExporter } from '../../src/observability/trace-exporter';
import { makeMessage, textOnlyResponse } from '../_helpers';

type MockModelResponse = LLMResponse & {
  id: string;
  output: LLMResponse['items'];
  status?: string;
};

function messageResponse(id: string, text: string): MockModelResponse {
  return frameworkCast<MockModelResponse>({
    id,
    status: 'completed',
    output: [
      {
        id: `msg-${id}`,
        status: 'completed',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text,
          },
        ],
      },
    ],
    items: [],
    usage: {
      inputTokens: 12,
      outputTokens: 7,
    },
    cost: 0.0042,
  });
}

/** Streaming client that returns a tool call on the first round, then a final message. */
class ToolCallThenDoneClient {
  calls = 0;

  callModel(): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<MockModelResponse>;
  } {
    return {
      async *getFullResponsesStream() {},
      getResponse: async () => {
        this.calls += 1;
        if (this.calls === 1) {
          return frameworkCast<MockModelResponse>({
            id: 'resp-tool-call',
            status: 'completed',
            output: [
              {
                id: 'fc-count',
                status: 'completed',
                type: 'function_call',
                callId: 'call-count',
                name: 'count',
                arguments: '{"count":3}',
              },
            ],
            items: [],
            usage: {
              inputTokens: 5,
              outputTokens: 2,
              cost: 0.001,
            },
          });
        }
        return messageResponse('resp-final', 'done');
      },
    };
  }
}

describe('traceExporter wiring (issue #50)', () => {
  it('emits a model-call span with GenAI attributes for a tool-less call', async () => {
    const exporter = new InMemoryExporter();
    const harness = new AgentHarness({
      name: 'repro',
      params: {},
      traceExporter: exporter,
      _testCallModel: async () => textOnlyResponse('hi'),
    });
    const ctx = harness.createContext();

    await harness.callModel({
      model: 'openai/gpt-4o-mini',
      items: [
        makeMessage('user', 'hello'),
      ],
    });

    expect(exporter.spans.length).toBeGreaterThanOrEqual(1);
    const modelSpan = exporter.spans.find(
      (s) => s.attributes.get(GenAI.REQUEST_MODEL) === 'openai/gpt-4o-mini',
    );
    expect(modelSpan).toBeDefined();
    expect(modelSpan?.endTime).toBeDefined();
    void ctx;
  });

  it('emits a span per model call and per tool call with usage/cost/tool attributes', async () => {
    const exporter = new InMemoryExporter();
    const harness = new AgentHarness({
      name: 'repro',
      params: {},
      traceExporter: exporter,
    });
    const fakeClient = new ToolCallThenDoneClient();
    frameworkCast<{
      client: ToolCallThenDoneClient;
    }>(harness).client = fakeClient;
    const ctx = harness.createContext();

    const countingTool = tool({
      name: 'count',
      description: 'returns the count',
      input: z.object({
        count: z.number(),
      }),
      output: z.object({
        count: z.number(),
      }),
      execute: async (args) => ({
        count: args.count,
      }),
    });

    await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'count'),
      ],
      tools: [
        countingTool,
      ],
      ctx,
    });

    const modelSpans = exporter.spans.filter((s) => s.attributes.has(GenAI.REQUEST_MODEL));
    expect(modelSpans.length).toBe(2);
    const firstModelSpan = modelSpans[0];
    expect(firstModelSpan?.attributes.get(GenAI.USAGE_INPUT_TOKENS)).toBe(5);
    expect(firstModelSpan?.attributes.get(GenAI.USAGE_OUTPUT_TOKENS)).toBe(2);
    expect(firstModelSpan?.attributes.get(GenAI.COST)).toBe(0.001);

    const toolSpans = exporter.spans.filter((s) => s.attributes.get(ToolAttr.NAME) === 'count');
    expect(toolSpans.length).toBe(1);
    expect(toolSpans[0]?.endTime).toBeDefined();
  });
});
