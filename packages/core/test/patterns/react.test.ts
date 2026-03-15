import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { react } from '../../src/patterns/react';
import { InMemoryRuntime } from '../../src/runtime/in-memory-runtime';
import type { LLMResponse } from '../../src/types/common';
import type { FunctionCallItem, FunctionCallOutputItem, MessageItem } from '../../src/types/items';

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
      system: 'You are a helpful assistant',
      tools: [
        searchTool,
      ],
      maxSteps: 5,
    });

    expect(reactStep.kind).toBe('loop');
    expect(reactStep.id).toBe('react-loop');
    expect(reactStep.body.kind).toBe('llm');
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

    let callCount = 0;
    const mockCallModel = async (): Promise<LLMResponse> => {
      callCount++;

      if (callCount === 1) {
        // First call: LLM decides to use search tool
        return {
          items: [
            {
              id: `fc-${callCount}`,
              status: 'completed',
              type: 'function_call',
              call_id: `call_${callCount}`,
              name: 'search',
              arguments: '{"query":"test query"}',
            } as FunctionCallItem,
            {
              id: `fco-${callCount}`,
              status: 'completed',
              type: 'function_call_output',
              call_id: `call_${callCount}`,
              output: '{"results":["found: test query"]}',
            } as FunctionCallOutputItem,
            {
              id: `msg-${callCount}`,
              status: 'completed',
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'I searched and found results.',
                },
              ],
            } as MessageItem,
          ],
          usage: {
            inputTokens: 50,
            outputTokens: 30,
          },
          cost: 0.001,
        };
      }

      // Second call: LLM responds without tool calls (stops)
      return {
        items: [
          {
            id: `msg-${callCount}`,
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'Based on my search, here is the answer.',
              },
            ],
          } as MessageItem,
        ],
        usage: {
          inputTokens: 80,
          outputTokens: 40,
        },
        cost: 0.002,
      };
    };

    const runtime = new InMemoryRuntime({
      callModel: mockCallModel,
    });
    const ctx = runtime.createContext();

    const reactStep = react({
      model: 'gpt-4',
      tools: [
        searchTool,
      ],
      maxSteps: 10,
    });

    const result = await runtime.execute(reactStep, 'What is the answer?', ctx);

    // Should have called model twice (once with tool call, once without)
    expect(callCount).toBe(2);
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

    let callCount = 0;
    const mockCallModel = async (): Promise<LLMResponse> => {
      callCount++;
      return {
        items: [
          {
            id: `fc-${callCount}`,
            status: 'completed',
            type: 'function_call',
            call_id: `call_${callCount}`,
            name: 'always',
            arguments: '{}',
          } as FunctionCallItem,
          {
            id: `fco-${callCount}`,
            status: 'completed',
            type: 'function_call_output',
            call_id: `call_${callCount}`,
            output: '"ok"',
          } as FunctionCallOutputItem,
          {
            id: `msg-${callCount}`,
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: `Step ${callCount}`,
              },
            ],
          } as MessageItem,
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 10,
        },
      };
    };

    const runtime = new InMemoryRuntime({
      callModel: mockCallModel,
    });
    const ctx = runtime.createContext();

    const reactStep = react({
      model: 'gpt-4',
      tools: [
        tool,
      ],
      maxSteps: 3,
    });

    const _result = await runtime.execute(reactStep, 'go', ctx);
    expect(callCount).toBe(3); // Stopped at maxSteps
  });

  it('terminates on noToolCalls', async () => {
    const tool = {
      name: 'maybe',
      description: 'Maybe called',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ok',
    };

    let callCount = 0;
    const mockCallModel = async (): Promise<LLMResponse> => {
      callCount++;
      // First call has no tool calls — should stop immediately after step 1
      return {
        items: [
          {
            id: `msg-${callCount}`,
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'No tools needed',
              },
            ],
          } as MessageItem,
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 10,
        },
      };
    };

    const runtime = new InMemoryRuntime({
      callModel: mockCallModel,
    });
    const ctx = runtime.createContext();

    const reactStep = react({
      model: 'gpt-4',
      tools: [
        tool,
      ],
      maxSteps: 10,
    });

    // noToolCalls only fires after stepCount >= 1
    const result = await runtime.execute(reactStep, 'hi', ctx);
    expect(callCount).toBe(1);
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

    let callCount = 0;
    const mockCallModel = async (): Promise<LLMResponse> => {
      callCount++;
      if (callCount === 1) {
        return {
          items: [
            {
              id: 'fc1',
              status: 'completed',
              type: 'function_call',
              call_id: 'c1',
              name: 'search',
              arguments: '{"q":"x"}',
            } as FunctionCallItem,
            {
              id: 'fco1',
              status: 'completed',
              type: 'function_call_output',
              call_id: 'c1',
              output: '"found"',
            } as FunctionCallOutputItem,
            {
              id: 'm1',
              status: 'completed',
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'searching',
                },
              ],
            } as MessageItem,
          ],
          usage: {
            inputTokens: 100,
            outputTokens: 50,
          },
          cost: 0.01,
        };
      }
      return {
        items: [
          {
            id: 'm2',
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'done',
              },
            ],
          } as MessageItem,
        ],
        usage: {
          inputTokens: 200,
          outputTokens: 100,
        },
        cost: 0.02,
      };
    };

    const runtime = new InMemoryRuntime({
      callModel: mockCallModel,
    });
    const ctx = runtime.createContext();

    const reactStep = react({
      model: 'gpt-4',
      tools: [
        tool,
      ],
    });
    await runtime.execute(reactStep, 'test', ctx);

    expect(ctx.tokens.input).toBe(300);
    expect(ctx.tokens.output).toBe(150);
    expect(ctx.cost).toBe(0.03);
  });
});
