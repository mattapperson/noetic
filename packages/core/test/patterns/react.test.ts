import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { AgentHarness } from '../../src/harness/agent-harness';
import { react } from '../../src/patterns/react';
import type { LLMResponse } from '../../src/types/common';
import { createScriptedCallModel } from '../_helpers';

describe('ReAct pattern', () => {
  it('creates a loop step with correct structure', () => {
    const searchTool = {
      name: 'search',
      description: 'Search the web',
      input: z.object({
        query: z.string(),
      }),
      output: z.object({
        results: z.array(z.string()),
      }),
      execute: async (_args: { query: string }) => ({
        results: [
          'result1',
        ],
      }),
    };

    const reactStep = react({
      model: 'gpt-4',
      instructions: 'You are a helpful assistant',
      tools: [
        searchTool,
      ],
      maxSteps: 5,
    });

    assert(reactStep.kind === 'loop');
    expect(reactStep.id).toBe('react-loop');
    expect(reactStep.steps[0].kind).toBe('llm');
  });

  it('runs end-to-end with mocked LLM: tool calls then stops', async () => {
    const searchTool = {
      name: 'search',
      description: 'Search the web',
      input: z.object({
        query: z.string(),
      }),
      output: z.object({
        results: z.array(z.string()),
      }),
      execute: async (args: { query: string }) => ({
        results: [
          `found: ${args.query}`,
        ],
      }),
    };

    const script: LLMResponse[] = [
      // First call: LLM decides to use search tool
      {
        items: [
          {
            id: 'fc-1',
            status: 'completed',
            type: 'function_call',
            callId: 'call_1',
            name: 'search',
            arguments: '{"query":"test query"}',
          } satisfies LLMResponse['items'][number],
          {
            id: 'fco-1',
            status: 'completed',
            type: 'function_call_output',
            callId: 'call_1',
            output: '{"results":["found: test query"]}',
          } satisfies LLMResponse['items'][number],
          {
            id: 'msg-1',
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'I searched and found results.',
              },
            ],
          } satisfies LLMResponse['items'][number],
        ],
        usage: {
          inputTokens: 50,
          outputTokens: 30,
        },
        cost: 0.001,
      },
      // Second call: LLM responds without tool calls (stops)
      {
        items: [
          {
            id: 'msg-2',
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Based on my search, here is the answer.',
              },
            ],
          } satisfies LLMResponse['items'][number],
        ],
        usage: {
          inputTokens: 80,
          outputTokens: 40,
        },
        cost: 0.002,
      },
    ];

    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: createScriptedCallModel(script),
    });
    const ctx = harness.createContext();

    const reactStep = react({
      model: 'gpt-4',
      tools: [
        searchTool,
      ],
      maxSteps: 10,
    });

    const result = await harness.run(reactStep, 'What is the answer?', ctx);

    expect(result).toBe('Based on my search, here is the answer.');
  });

  it('stops at maxSteps even if tool calls continue', async () => {
    const tool = {
      name: 'always',
      description: 'Always called',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ok',
    };

    const script: LLMResponse[] = Array.from(
      {
        length: 3,
      },
      (_, i) => ({
        items: [
          {
            id: `fc-${i + 1}`,
            status: 'completed' as const,
            type: 'function_call' as const,
            callId: `call_${i + 1}`,
            name: 'always',
            arguments: '{}',
          },
          {
            id: `fco-${i + 1}`,
            status: 'completed' as const,
            type: 'function_call_output' as const,
            callId: `call_${i + 1}`,
            output: '"ok"',
          },
          {
            id: `msg-${i + 1}`,
            status: 'completed' as const,
            type: 'message' as const,
            role: 'assistant' as const,
            content: [
              {
                type: 'output_text' as const,
                text: `Step ${i + 1}`,
              },
            ],
          },
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 10,
        },
      }),
    );

    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: createScriptedCallModel(script),
    });
    const ctx = harness.createContext();

    const reactStep = react({
      model: 'gpt-4',
      tools: [
        tool,
      ],
      maxSteps: 3,
    });

    await harness.run(reactStep, 'go', ctx);
    // If maxSteps is respected, we consumed all 3 scripted responses
    expect(ctx.tokens.input).toBe(30);
  });

  it('terminates on noToolCalls', async () => {
    const tool = {
      name: 'maybe',
      description: 'Maybe called',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ok',
    };

    const script: LLMResponse[] = [
      {
        items: [
          {
            id: 'msg-1',
            status: 'completed' as const,
            type: 'message' as const,
            role: 'assistant' as const,
            content: [
              {
                type: 'output_text' as const,
                text: 'No tools needed',
              },
            ],
          },
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 10,
        },
      },
    ];

    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: createScriptedCallModel(script),
    });
    const ctx = harness.createContext();

    const reactStep = react({
      model: 'gpt-4',
      tools: [
        tool,
      ],
      maxSteps: 10,
    });

    // noToolCalls only fires after stepCount >= 1
    const result = await harness.run(reactStep, 'hi', ctx);
    expect(ctx.tokens.input).toBe(10); // Only one call
    expect(result).toBe('No tools needed');
  });

  it('tracks token usage across iterations', async () => {
    const tool = {
      name: 'search',
      description: 'Search',
      input: z.object({
        q: z.string(),
      }),
      output: z.string(),
      execute: async () => 'found',
    };

    const script: LLMResponse[] = [
      {
        items: [
          {
            id: 'fc1',
            status: 'completed' as const,
            type: 'function_call' as const,
            callId: 'c1',
            name: 'search',
            arguments: '{"q":"x"}',
          },
          {
            id: 'fco1',
            status: 'completed' as const,
            type: 'function_call_output' as const,
            callId: 'c1',
            output: '"found"',
          },
          {
            id: 'm1',
            status: 'completed' as const,
            type: 'message' as const,
            role: 'assistant' as const,
            content: [
              {
                type: 'output_text' as const,
                text: 'searching',
              },
            ],
          },
        ],
        usage: {
          inputTokens: 100,
          outputTokens: 50,
        },
        cost: 0.01,
      },
      {
        items: [
          {
            id: 'm2',
            status: 'completed' as const,
            type: 'message' as const,
            role: 'assistant' as const,
            content: [
              {
                type: 'output_text' as const,
                text: 'done',
              },
            ],
          },
        ],
        usage: {
          inputTokens: 200,
          outputTokens: 100,
        },
        cost: 0.02,
      },
    ];

    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: createScriptedCallModel(script),
    });
    const ctx = harness.createContext();

    const reactStep = react({
      model: 'gpt-4',
      tools: [
        tool,
      ],
    });
    await harness.run(reactStep, 'test', ctx);

    expect(ctx.tokens.input).toBe(300);
    expect(ctx.tokens.output).toBe(150);
    expect(ctx.cost).toBe(0.03);
  });
});
