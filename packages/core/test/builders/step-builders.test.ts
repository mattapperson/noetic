import { describe, it, expect } from 'bun:test';
import { step } from '../../src/builders/step-builders';
import { z } from 'zod';

describe('step builders', () => {
  it('step.run() produces correct shape', () => {
    const s = step.run({
      id: 'my-run',
      execute: async (input: string) => input.length,
    });
    expect(s.kind).toBe('run');
    expect(s.id).toBe('my-run');
    expect(s.execute).toBeFunction();
    expect(s.retry).toBeUndefined();
  });

  it('step.run() with retry policy', () => {
    const s = step.run({
      id: 'retry-run',
      execute: async (input: string) => input,
      retry: { maxAttempts: 3, backoff: 'exponential', initialDelay: 100 },
    });
    expect(s.retry).toEqual({ maxAttempts: 3, backoff: 'exponential', initialDelay: 100 });
  });

  it('step.llm() produces correct shape', () => {
    const s = step.llm({
      id: 'my-llm',
      model: 'gpt-4',
      system: 'You are helpful',
    });
    expect(s.kind).toBe('llm');
    expect(s.id).toBe('my-llm');
    expect(s.model).toBe('gpt-4');
    expect(s.system).toBe('You are helpful');
  });

  it('step.llm() with output schema', () => {
    const schema = z.object({ answer: z.string() });
    const s = step.llm({
      id: 'structured-llm',
      model: 'gpt-4',
      output: schema,
    });
    expect(s.output).toBe(schema);
  });

  it('step.llm() with tools', () => {
    const tool = {
      name: 'search',
      description: 'Search the web',
      input: z.object({ query: z.string() }),
      output: z.object({ results: z.array(z.string()) }),
      execute: async () => ({ results: [] }),
    };
    const s = step.llm({
      id: 'tool-llm',
      model: 'gpt-4',
      tools: [tool],
    });
    expect(s.tools).toHaveLength(1);
    expect(s.tools![0].name).toBe('search');
  });

  it('step.tool() produces correct shape', () => {
    const myTool = {
      name: 'calculator',
      description: 'Calculate',
      input: z.object({ expression: z.string() }),
      output: z.object({ result: z.number() }),
      execute: async () => ({ result: 42 }),
    };
    const s = step.tool({
      id: 'my-tool',
      tool: myTool,
    });
    expect(s.kind).toBe('tool');
    expect(s.id).toBe('my-tool');
    expect(s.tool.name).toBe('calculator');
  });

  it('step.tool() with args', () => {
    const myTool = {
      name: 'calculator',
      description: 'Calculate',
      input: z.object({ expression: z.string() }),
      output: z.object({ result: z.number() }),
      execute: async () => ({ result: 42 }),
    };
    const s = step.tool({
      id: 'my-tool',
      tool: myTool,
      args: { expression: '2+2' },
    });
    expect(s.args).toEqual({ expression: '2+2' });
  });
});
