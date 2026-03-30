/**
 * Live OpenRouter integration test — exercises the real adapter path.
 * Skipped when OPENROUTER_API_KEY is not set.
 */

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import { AgentHarness, loop, step, tool, until } from '../src/index';
import type { ContextMemory } from '../src/types/memory';
import { assertOpenResponsesCompliance } from './_helpers';

// Live tests require both an API key and explicit opt-in via NOETIC_LIVE_TESTS=1
// to avoid accidental API charges and timeouts during `bun test`.
const RUN_LIVE = !!process.env.OPENROUTER_API_KEY && !!process.env.NOETIC_LIVE_TESTS;

describe.skipIf(!RUN_LIVE)('live OpenRouter integration', () => {
  test('simple LLM step returns valid OpenResponses items', async () => {
    const llmStep = step.llm<ContextMemory, string, string>({
      id: 'live-simple',
      model: 'openai/gpt-4o-mini',
      system: 'You are a helpful assistant. Reply in exactly one sentence.',
    });

    const harness = new AgentHarness({
      name: 'live-simple-test',
      params: {},
      llm: {
        provider: 'openrouter',
        apiKey: process.env.OPENROUTER_API_KEY!,
      },
    });

    const ctx = harness.createContext();
    const result = await harness.run(llmStep, 'What is 2 + 2?', ctx);

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(ctx.tokens.input).toBeGreaterThan(0);
    expect(ctx.tokens.output).toBeGreaterThan(0);
    expect(ctx.itemLog.items.length).toBeGreaterThanOrEqual(2); // user + assistant

    assertOpenResponsesCompliance(ctx.itemLog.items);
  });

  test('structured output with Zod schema parses correctly via json_schema format', async () => {
    // The harness now auto-sends text.format with json_schema when step.output
    // is provided, so the model is constrained to return valid JSON.
    const AnswerSchema = z.object({
      answer: z.number(),
      explanation: z.string(),
    });

    const llmStep = step.llm<
      ContextMemory,
      string,
      {
        answer: number;
        explanation: string;
      }
    >({
      id: 'live-structured',
      model: 'openai/gpt-4o-mini',
      system: 'You are a math assistant. Respond with JSON.',
      output: AnswerSchema,
    });

    const harness = new AgentHarness({
      name: 'live-structured-test',
      params: {},
      llm: {
        provider: 'openrouter',
        apiKey: process.env.OPENROUTER_API_KEY!,
      },
    });

    const ctx = harness.createContext();
    const result = await harness.run(llmStep, 'What is 7 * 8?', ctx);

    expect(typeof result.answer).toBe('number');
    expect(typeof result.explanation).toBe('string');
    expect(result.answer).toBe(56);
  });

  test('tool calls are visible in Noetic itemLog', async () => {
    // Noetic now manages the tool loop itself (no execute callbacks to SDK),
    // so function_call and function_call_output items appear in the response.
    let toolWasCalled = false;

    const calculatorTool = tool({
      name: 'calculator',
      description: 'Perform arithmetic calculations. Use this tool for any math.',
      input: z.object({
        expression: z.string().describe('Math expression like "2 + 2"'),
      }),
      output: z.object({
        result: z.number(),
      }),
      execute: async (args) => {
        toolWasCalled = true;
        return {
          result: Number(Function(`"use strict"; return (${args.expression})`)()),
        };
      },
    });

    const llmStep = step.llm<ContextMemory, string, string>({
      id: 'live-tool',
      model: 'openai/gpt-4o-mini',
      system:
        'You are a math assistant. Use the calculator tool for all computations. After getting the result, state it clearly.',
      tools: [
        calculatorTool,
      ],
    });

    const harness = new AgentHarness({
      name: 'live-tool-test',
      params: {},
      llm: {
        provider: 'openrouter',
        apiKey: process.env.OPENROUTER_API_KEY!,
      },
    });

    const ctx = harness.createContext();
    const result = await harness.run(llmStep, 'What is 15 * 23?', ctx);

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(toolWasCalled).toBe(true);

    // Tool interactions are now visible in the itemLog
    const toolCalls = ctx.itemLog.items.filter((i) => i.type === 'function_call');
    const toolOutputs = ctx.itemLog.items.filter((i) => i.type === 'function_call_output');
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolOutputs.length).toBeGreaterThanOrEqual(1);

    assertOpenResponsesCompliance(ctx.itemLog.items);
  });

  test('until.noToolCalls correctly loops when tools are called', async () => {
    // Noetic now manages the tool loop, so function_call items appear in the
    // response. until.noToolCalls() sees them and continues the loop. The loop
    // stops when the model responds without tool calls.
    let toolCallCount = 0;

    const factTool = tool({
      name: 'get_fact',
      description: 'Get a fun fact about a number',
      input: z.object({
        number: z.number(),
      }),
      output: z.object({
        fact: z.string(),
      }),
      execute: async (args) => {
        toolCallCount++;
        return {
          fact: `${args.number} is the number of sides on a ${args.number}-gon.`,
        };
      },
    });

    const agentLoop = loop<ContextMemory, string, string>({
      id: 'live-loop',
      steps: [
        step.llm<ContextMemory, string, string>({
          id: 'live-loop-llm',
          model: 'openai/gpt-4o-mini',
          system: 'You are a fun facts assistant. Use get_fact tool once, then provide a summary.',
          tools: [
            factTool,
          ],
        }),
      ],
      until: until.noToolCalls(),
      maxIterations: 5,
    });

    const harness = new AgentHarness({
      name: 'live-loop-test',
      params: {},
      llm: {
        provider: 'openrouter',
        apiKey: process.env.OPENROUTER_API_KEY!,
      },
    });

    const ctx = harness.createContext();
    const result = await harness.run(agentLoop, 'Tell me a fun fact about the number 7', ctx);

    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
    expect(toolCallCount).toBeGreaterThanOrEqual(1);

    // Loop ran >1 iteration: first with tool calls, then without
    // stepCount includes the loop step itself + each LLM iteration
    expect(ctx.stepCount).toBeGreaterThanOrEqual(3);

    assertOpenResponsesCompliance(ctx.itemLog.items);
  });

  test('multi-step pipeline with code and LLM steps', async () => {
    const classifyStep = step.run<
      ContextMemory,
      string,
      {
        topic: string;
        wordCount: number;
      }
    >({
      id: 'classify',
      execute: async (input) => ({
        topic: input.toLowerCase().includes('code') ? 'programming' : 'general',
        wordCount: input.split(/\s+/).length,
      }),
    });

    const llmStep = step.llm<ContextMemory, string, string>({
      id: 'respond',
      model: 'openai/gpt-4o-mini',
      system: 'You are a concise assistant. Reply in one sentence.',
    });

    const pipeline = step.run<ContextMemory, string, string>({
      id: 'pipeline',
      execute: async (input, ctx) => {
        const classification = await ctx.harness.run(classifyStep, input, ctx);
        const prompt = `Topic: ${classification.topic} (${classification.wordCount} words). User said: ${input}`;
        const response = await ctx.harness.run(llmStep, prompt, ctx);
        return `[${classification.topic}] ${response}`;
      },
    });

    const harness = new AgentHarness({
      name: 'live-pipeline-test',
      params: {},
      llm: {
        provider: 'openrouter',
        apiKey: process.env.OPENROUTER_API_KEY!,
      },
    });

    const ctx = harness.createContext();
    const result = await harness.run(pipeline, 'How do I write clean code?', ctx);

    expect(typeof result).toBe('string');
    expect(result).toContain('[programming]');
    expect(ctx.tokens.total).toBeGreaterThan(0);
    expect(ctx.cost).toBeGreaterThanOrEqual(0);
  });
});
