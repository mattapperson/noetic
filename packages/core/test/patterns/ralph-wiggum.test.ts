import { describe, it, expect } from 'bun:test';
import { ralphWiggum } from '../../src/patterns/ralph-wiggum';
import { InMemoryRuntime } from '../../src/runtime/in-memory-runtime';
import type { LLMResponse } from '../../src/types/common';
import type { Item, MessageItem, FunctionCallItem, FunctionCallOutputItem } from '../../src/types/items';
import { z } from 'zod';

describe('Ralph Wiggum pattern', () => {
  it('creates correct step structure', () => {
    const tool = {
      name: 'write', description: 'Write', input: z.object({ code: z.string() }),
      output: z.string(), execute: async () => 'ok',
    };
    const rw = ralphWiggum({ model: 'gpt-4', system: 'Write code', tools: [tool], verify: async () => ({ pass: true }) });
    expect(rw.kind).toBe('loop');
    expect(rw.id).toBe('ralph-wiggum-loop');
    expect(rw.body.kind).toBe('spawn');
  });

  it('outer loop + fresh spawn + inner ReAct with verify + feedback', async () => {
    const tool = {
      name: 'write', description: 'Write code',
      input: z.object({ code: z.string() }), output: z.string(),
      execute: async (args: { code: string }) => `Written: ${args.code}`,
    };

    let llmCallCount = 0;
    const mockCallModel = async (): Promise<LLMResponse> => {
      llmCallCount++;
      if (llmCallCount % 2 === 1) {
        return {
          items: [
            { id: `fc-${llmCallCount}`, status: 'completed', type: 'function_call', call_id: `call_${llmCallCount}`, name: 'write', arguments: `{"code":"attempt ${Math.ceil(llmCallCount / 2)}"}` } as FunctionCallItem,
            { id: `fco-${llmCallCount}`, status: 'completed', type: 'function_call_output', call_id: `call_${llmCallCount}`, output: '"ok"' } as FunctionCallOutputItem,
            { id: `msg-${llmCallCount}`, status: 'completed', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Writing...' }] } as MessageItem,
          ],
          usage: { inputTokens: 10, outputTokens: 10 },
        };
      }
      return {
        items: [{ id: `msg-${llmCallCount}`, status: 'completed', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Done attempt ${llmCallCount / 2}` }] } as MessageItem],
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    };

    const runtime = new InMemoryRuntime({ callModel: mockCallModel });
    const ctx = runtime.createContext();

    let verifyCount = 0;
    const rw = ralphWiggum({
      model: 'gpt-4', system: 'Write code', tools: [tool],
      verify: async () => { verifyCount++; return verifyCount >= 3 ? { pass: true } : { pass: false, feedback: `Attempt ${verifyCount} failed` }; },
      maxIterations: 5, innerMaxSteps: 5,
    });

    await runtime.execute(rw, 'Write a function', ctx);
    expect(verifyCount).toBe(3);
    expect(llmCallCount).toBe(6);
  });

  it('respects maxIterations', async () => {
    const tool = { name: 'noop', description: 'No-op', input: z.object({}), output: z.string(), execute: async () => 'ok' };
    const mockCallModel = async (): Promise<LLMResponse> => ({
      items: [{ id: `msg-${Date.now()}`, status: 'completed', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } as MessageItem],
      usage: { inputTokens: 5, outputTokens: 5 },
    });

    const runtime = new InMemoryRuntime({ callModel: mockCallModel });
    const ctx = runtime.createContext();
    let verifyCount = 0;
    const rw = ralphWiggum({
      model: 'gpt-4', system: 'Test', tools: [tool],
      verify: async () => { verifyCount++; return { pass: false, feedback: 'keep trying' }; },
      maxIterations: 3, innerMaxSteps: 2,
    });
    await runtime.execute(rw, 'go', ctx);
    expect(verifyCount).toBe(3);
  });

  it('context resets each iteration (fresh spawn)', async () => {
    const tool = { name: 'log', description: 'Log', input: z.object({}), output: z.string(), execute: async () => 'ok' };
    const itemCounts: number[] = [];
    const mockCallModel = async (_m: string, items: ReadonlyArray<Item>): Promise<LLMResponse> => {
      itemCounts.push(items.length);
      return {
        items: [{ id: `msg-${Date.now()}-${Math.random()}`, status: 'completed', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'resp' }] } as MessageItem],
        usage: { inputTokens: 5, outputTokens: 5 },
      };
    };
    const runtime = new InMemoryRuntime({ callModel: mockCallModel });
    const ctx = runtime.createContext();
    let iter = 0;
    const rw = ralphWiggum({
      model: 'gpt-4', system: 'Test', tools: [tool],
      verify: async () => { iter++; return { pass: iter >= 3, feedback: 'retry' }; },
      maxIterations: 5, innerMaxSteps: 2,
    });
    await runtime.execute(rw, 'start', ctx);
    for (const count of itemCounts) {
      expect(count).toBeLessThanOrEqual(3);
    }
  });
});
