import { describe, it, expect } from 'bun:test';
import { executeTool } from '../../src/interpreter/execute-tool';
import { isOrchidError, OrchidErrorImpl } from '../../src/errors/orchid-error';
import type { StepTool } from '../../src/types/step';
import type { Context } from '../../src/types/context';
import { z } from 'zod';

const mockCtx = {} as Context;

describe('executeTool', () => {
  it('calls tool.execute() and returns typed output', async () => {
    const tool = {
      name: 'add',
      description: 'Add two numbers',
      input: z.object({ a: z.number(), b: z.number() }),
      output: z.object({ sum: z.number() }),
      execute: async (args: { a: number; b: number }) => ({ sum: args.a + args.b }),
    };
    const s: StepTool<{ a: number; b: number }, { sum: number }> = {
      kind: 'tool', id: 'add-test', tool,
    };
    const result = await executeTool(s, { a: 3, b: 4 }, mockCtx);
    expect(result).toEqual({ sum: 7 });
  });

  it('validates input against Zod schema', async () => {
    const tool = {
      name: 'greet',
      description: 'Greet',
      input: z.object({ name: z.string() }),
      output: z.object({ greeting: z.string() }),
      execute: async (args: { name: string }) => ({ greeting: `Hi ${args.name}` }),
    };
    const s: StepTool<any, any> = { kind: 'tool', id: 'greet-test', tool };

    try {
      await executeTool(s, { name: 123 }, mockCtx); // wrong type
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
      expect((e as OrchidErrorImpl).orchidError.kind).toBe('step_failed');
    }
  });

  it('merges step.args with input', async () => {
    let receivedArgs: any;
    const tool = {
      name: 'search',
      description: 'Search',
      input: z.object({ query: z.string(), limit: z.number() }),
      output: z.object({ results: z.array(z.string()) }),
      execute: async (args: any) => { receivedArgs = args; return { results: [] }; },
    };
    const s: StepTool<any, any> = {
      kind: 'tool', id: 'search-test', tool,
      args: { limit: 5 },
    };
    await executeTool(s, { query: 'test', limit: 10 }, mockCtx);
    expect(receivedArgs.query).toBe('test');
    expect(receivedArgs.limit).toBe(5); // step.args overrides
  });

  it('passes context to tool.execute', async () => {
    let receivedCtx: any;
    const tool = {
      name: 'ctx-test',
      description: 'Test',
      input: z.object({}),
      output: z.string(),
      execute: async (_args: any, ctx: any) => { receivedCtx = ctx; return 'ok'; },
    };
    const s: StepTool<any, any> = { kind: 'tool', id: 'ctx-test', tool };
    await executeTool(s, {}, mockCtx);
    expect(receivedCtx).toBe(mockCtx);
  });

  it('wraps tool execution errors in step_failed', async () => {
    const tool = {
      name: 'failing',
      description: 'Fails',
      input: z.object({}),
      output: z.string(),
      execute: async () => { throw new Error('tool broke'); },
    };
    const s: StepTool<any, any> = { kind: 'tool', id: 'fail-test', tool };

    try {
      await executeTool(s, {}, mockCtx);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
      const oe = (e as OrchidErrorImpl).orchidError;
      expect(oe.kind).toBe('step_failed');
      if (oe.kind === 'step_failed') {
        expect(oe.cause.message).toBe('tool broke');
      }
    }
  });
});
