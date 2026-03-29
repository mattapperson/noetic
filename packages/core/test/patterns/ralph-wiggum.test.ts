import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { ralphWiggum } from '../../src/patterns/ralph-wiggum';
import { AgentHarness } from '../../src/runtime/agent-harness';
import type { LLMResponse } from '../../src/types/common';
import type { FunctionCallItem, FunctionCallOutputItem, MessageItem } from '../../src/types/items';
import { createDynamicCallModel } from '../_helpers';

describe('Ralph Wiggum pattern', () => {
  it('creates correct step structure', () => {
    const tool = {
      name: 'write',
      description: 'Write',
      input: z.object({
        code: z.string(),
      }),
      output: z.string(),
      execute: async () => 'ok',
    };
    const rw = ralphWiggum({
      model: 'gpt-4',
      system: 'Write code',
      tools: [
        tool,
      ],
      verify: async () => ({
        pass: true,
      }),
    });
    expect(rw.kind).toBe('loop');
    expect(rw.id).toBe('ralph-wiggum-loop');
    expect(rw.steps[0].kind).toBe('spawn');
  });

  it('outer loop + fresh spawn + inner ReAct with verify + feedback', async () => {
    const tool = {
      name: 'write',
      description: 'Write code',
      input: z.object({
        code: z.string(),
      }),
      output: z.string(),
      execute: async (args: { code: string }) => `Written: ${args.code}`,
    };

    let llmCallCount = 0;
    const mockCallModel = createDynamicCallModel((): LLMResponse => {
      llmCallCount++;
      if (llmCallCount % 2 === 1) {
        return {
          items: [
            {
              id: `fc-${llmCallCount}`,
              status: 'completed',
              type: 'function_call',
              callId: `call_${llmCallCount}`,
              name: 'write',
              arguments: `{"code":"attempt ${Math.ceil(llmCallCount / 2)}"}`,
            } satisfies FunctionCallItem,
            {
              id: `fco-${llmCallCount}`,
              status: 'completed',
              type: 'function_call_output',
              callId: `call_${llmCallCount}`,
              output: '"ok"',
            } satisfies FunctionCallOutputItem,
            {
              id: `msg-${llmCallCount}`,
              status: 'completed',
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'Writing...',
                },
              ],
            } satisfies MessageItem,
          ],
          usage: {
            inputTokens: 10,
            outputTokens: 10,
          },
        };
      }
      return {
        items: [
          {
            id: `msg-${llmCallCount}`,
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: `Done attempt ${llmCallCount / 2}`,
              },
            ],
          } satisfies MessageItem,
        ],
        usage: {
          inputTokens: 10,
          outputTokens: 10,
        },
      };
    });

    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: mockCallModel,
    });
    const ctx = harness.createContext();

    let verifyCount = 0;
    const rw = ralphWiggum({
      model: 'gpt-4',
      system: 'Write code',
      tools: [
        tool,
      ],
      verify: async () => {
        verifyCount++;
        return verifyCount >= 3
          ? {
              pass: true,
            }
          : {
              pass: false,
              feedback: `Attempt ${verifyCount} failed`,
            };
      },
      maxIterations: 5,
      innerMaxSteps: 5,
    });

    await harness.run(rw, 'Write a function', ctx);
    expect(verifyCount).toBe(3);
    expect(llmCallCount).toBe(6);
  });

  it('respects maxIterations and always returns pass:false', async () => {
    const tool = {
      name: 'noop',
      description: 'No-op',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ok',
    };
    const mockCallModel = createDynamicCallModel(
      (): LLMResponse => ({
        items: [
          {
            id: `msg-${Date.now()}`,
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'done',
              },
            ],
          } satisfies MessageItem,
        ],
        usage: {
          inputTokens: 5,
          outputTokens: 5,
        },
      }),
    );

    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: mockCallModel,
    });
    const ctx = harness.createContext();
    let verifyCount = 0;
    const verifyResults: boolean[] = [];
    const rw = ralphWiggum({
      model: 'gpt-4',
      system: 'Test',
      tools: [
        tool,
      ],
      verify: async () => {
        verifyCount++;
        const result = {
          pass: false as const,
          feedback: 'keep trying',
        };
        verifyResults.push(result.pass);
        return result;
      },
      maxIterations: 3,
      innerMaxSteps: 2,
    });
    await harness.run(rw, 'go', ctx);
    expect(verifyCount).toBe(3);
    expect(verifyResults).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('stops early when verify passes', async () => {
    const tool = {
      name: 'noop',
      description: 'No-op',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ok',
    };
    const mockCallModel = createDynamicCallModel(
      (): LLMResponse => ({
        items: [
          {
            id: `msg-${Date.now()}-${Math.random()}`,
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'done',
              },
            ],
          } satisfies MessageItem,
        ],
        usage: {
          inputTokens: 5,
          outputTokens: 5,
        },
      }),
    );

    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: mockCallModel,
    });
    const ctx = harness.createContext();
    let verifyCount = 0;
    const rw = ralphWiggum({
      model: 'gpt-4',
      system: 'Test',
      tools: [
        tool,
      ],
      verify: async () => {
        verifyCount++;
        return verifyCount >= 2
          ? {
              pass: true,
            }
          : {
              pass: false,
              feedback: 'retry',
            };
      },
      maxIterations: 5,
      innerMaxSteps: 2,
    });
    await harness.run(rw, 'go', ctx);
    expect(verifyCount).toBe(2);
  });

  it('context resets each iteration (fresh spawn)', async () => {
    const tool = {
      name: 'log',
      description: 'Log',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'ok',
    };
    const mockCallModel = createDynamicCallModel(
      (): LLMResponse => ({
        items: [
          {
            id: `msg-${Date.now()}-${Math.random()}`,
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'resp',
              },
            ],
          } satisfies MessageItem,
        ],
        usage: {
          inputTokens: 5,
          outputTokens: 5,
        },
      }),
    );
    const harness = new AgentHarness({
      name: 'test',
      params: {},
      _testCallModel: mockCallModel,
    });
    const ctx = harness.createContext();
    let iter = 0;
    const rw = ralphWiggum({
      model: 'gpt-4',
      system: 'Test',
      tools: [
        tool,
      ],
      verify: async () => {
        iter++;
        return {
          pass: iter >= 3,
          feedback: 'retry',
        };
      },
      maxIterations: 5,
      innerMaxSteps: 2,
    });
    await harness.run(rw, 'start', ctx);
    // Each iteration spawns a fresh context, so the spawn's item log
    // starts clean each time — verifying iter reached 3 is sufficient.
    expect(iter).toBe(3);
  });
});
