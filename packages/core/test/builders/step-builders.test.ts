import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { callModel, invokeTool, runCode } from '../../src/builders/step-builders';
import { makeMockContext } from '../_helpers';

describe('step builders', () => {
  it('runCode() produces correct shape', async () => {
    const s = runCode({
      id: 'my-run',
      execute: async (input: string) => input.length,
    });
    expect(s.kind).toBe('runCode');
    expect(s.id).toBe('my-run');
    expect(s.execute).toBeFunction();
    expect(s.retry).toBeUndefined();
    const result = await s.execute('hello', makeMockContext());
    expect(result).toBe(5);
  });

  it('runCode() with retry policy', () => {
    const s = runCode({
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

  it('callModel() produces correct shape', () => {
    const s = callModel({
      id: 'my-llm',
      model: 'gpt-4',
      instructions: 'You are helpful',
    });
    expect(s.kind).toBe('callModel');
    expect(s.id).toBe('my-llm');
    expect(s.model).toBe('gpt-4');
    expect(s.instructions).toBe('You are helpful');
  });

  it('callModel() with output schema', () => {
    const schema = z.object({
      answer: z.string(),
    });
    const s = callModel({
      id: 'structured-llm',
      model: 'gpt-4',
      output: schema,
    });
    expect(s.output).toBe(schema);
  });

  it('callModel() with tools', () => {
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
    const s = callModel({
      id: 'tool-llm',
      model: 'gpt-4',
      tools: [
        tool,
      ],
    });
    // `tools` is `Lazy<Tool[] | undefined>`; narrow to the eager-array conditional
    // before indexing.
    expect(Array.isArray(s.tools)).toBe(true);
    const eagerTools = Array.isArray(s.tools) ? s.tools : [];
    expect(eagerTools).toHaveLength(1);
    expect(eagerTools[0]).toBe(tool);
  });

  it('invokeTool() produces correct shape', () => {
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
    const s = invokeTool({
      id: 'my-tool',
      tool: myTool,
    });
    expect(s.kind).toBe('invokeTool');
    expect(s.id).toBe('my-tool');
    expect(s.tool.name).toBe('calculator');
  });

  it('runCode() throws on empty id', () => {
    expect(() =>
      runCode({
        id: '',
        execute: async () => {},
      }),
    ).toThrow('non-empty id');
    expect(() =>
      runCode({
        id: '  ',
        execute: async () => {},
      }),
    ).toThrow('non-empty id');
  });

  it('runCode() throws on missing execute', () => {
    expect(() =>
      runCode({
        id: 'test',
        // @ts-expect-error — intentionally passing invalid opts to test runtime validation
        execute: undefined,
      }),
    ).toThrow('execute function');
  });

  it('callModel() throws on empty id', () => {
    expect(() =>
      callModel({
        id: '',
        model: 'gpt-4',
      }),
    ).toThrow('non-empty id');
  });

  it('callModel() throws on empty model', () => {
    expect(() =>
      callModel({
        id: 'test',
        model: '',
      }),
    ).toThrow('non-empty model');
  });

  it('invokeTool() throws on empty id', () => {
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
      invokeTool({
        id: '',
        tool: myTool,
      }),
    ).toThrow('non-empty id');
  });

  it('invokeTool() throws on missing tool', () => {
    expect(() =>
      invokeTool({
        id: 'test',
        // @ts-expect-error — intentionally passing invalid opts to test runtime validation
        tool: undefined,
      }),
    ).toThrow('requires a tool');
  });

  it('invokeTool() with args', () => {
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
    const s = invokeTool({
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
