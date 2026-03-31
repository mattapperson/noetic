import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { step } from '../../src/builders/step-builders';
import { makeMockContext } from '../_helpers';

describe('step builders', () => {
  it('step.run() produces correct shape', async () => {
    const s = step.run({
      id: 'my-run',
      execute: async (input: string) => input.length,
    });
    expect(s.kind).toBe('run');
    expect(s.id).toBe('my-run');
    expect(s.execute).toBeFunction();
    expect(s.retry).toBeUndefined();
    const result = await s.execute('hello', makeMockContext());
    expect(result).toBe(5);
  });

  it('step.run() with retry policy', () => {
    const s = step.run({
      id: 'retry-run',
      execute: async (input: string) => input,
      retry: {
        maxAttempts: 3,
        backoff: 'exponential',
        initialDelay: 100,
      },
    });
    expect(s.retry).toEqual({
      maxAttempts: 3,
      backoff: 'exponential',
      initialDelay: 100,
    });
  });

  it('step.llm() produces correct shape', () => {
    const s = step.llm({
      id: 'my-llm',
      model: 'gpt-4',
      instructions: 'You are helpful',
    });
    expect(s.kind).toBe('llm');
    expect(s.id).toBe('my-llm');
    expect(s.model).toBe('gpt-4');
    expect(s.instructions).toBe('You are helpful');
  });

  it('step.llm() with output schema', () => {
    const schema = z.object({
      answer: z.string(),
    });
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
      input: z.object({
        query: z.string(),
      }),
      output: z.object({
        results: z.array(z.string()),
      }),
      execute: async () => ({
        results: [],
      }),
    };
    const s = step.llm({
      id: 'tool-llm',
      model: 'gpt-4',
      tools: [
        tool,
      ],
    });
    expect(s.tools).toHaveLength(1);
    expect(s.tools![0]).toBe(tool);
  });

  it('step.tool() produces correct shape', () => {
    const myTool = {
      name: 'calculator',
      description: 'Calculate',
      input: z.object({
        expression: z.string(),
      }),
      output: z.object({
        result: z.number(),
      }),
      execute: async () => ({
        result: 42,
      }),
    };
    const s = step.tool({
      id: 'my-tool',
      tool: myTool,
    });
    expect(s.kind).toBe('tool');
    expect(s.id).toBe('my-tool');
    expect(s.tool.name).toBe('calculator');
  });

  it('step.run() throws on empty id', () => {
    expect(() =>
      step.run({
        id: '',
        execute: async () => {},
      }),
    ).toThrow('non-empty id');
    expect(() =>
      step.run({
        id: '  ',
        execute: async () => {},
      }),
    ).toThrow('non-empty id');
  });

  it('step.run() throws on missing execute', () => {
    expect(() =>
      step.run({
        id: 'test',
        // @ts-expect-error — intentionally passing invalid opts to test runtime validation
        execute: undefined,
      }),
    ).toThrow('execute function');
  });

  it('step.llm() throws on empty id', () => {
    expect(() =>
      step.llm({
        id: '',
        model: 'gpt-4',
      }),
    ).toThrow('non-empty id');
  });

  it('step.llm() throws on empty model', () => {
    expect(() =>
      step.llm({
        id: 'test',
        model: '',
      }),
    ).toThrow('non-empty model');
  });

  it('step.tool() throws on empty id', () => {
    const myTool = {
      name: 'calc',
      description: 'Calc',
      input: z.object({
        x: z.string(),
      }),
      output: z.object({
        r: z.number(),
      }),
      execute: async () => ({
        r: 1,
      }),
    };
    expect(() =>
      step.tool({
        id: '',
        tool: myTool,
      }),
    ).toThrow('non-empty id');
  });

  it('step.tool() throws on missing tool', () => {
    expect(() =>
      step.tool({
        id: 'test',
        // @ts-expect-error — intentionally passing invalid opts to test runtime validation
        tool: undefined,
      }),
    ).toThrow('requires a tool');
  });

  it('step.tool() with args', () => {
    const myTool = {
      name: 'calculator',
      description: 'Calculate',
      input: z.object({
        expression: z.string(),
      }),
      output: z.object({
        result: z.number(),
      }),
      execute: async () => ({
        result: 42,
      }),
    };
    const s = step.tool({
      id: 'my-tool',
      tool: myTool,
      args: {
        expression: '2+2',
      },
    });
    expect(s.args).toEqual({
      expression: '2+2',
    });
  });
});
