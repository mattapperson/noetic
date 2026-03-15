import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { isOrchidError } from '../../src/errors/orchid-error';
import { executeTool } from '../../src/interpreter/execute-tool';
import type { StepTool } from '../../src/types/step';
import { makeMockContext } from '../_helpers';

const mockCtx = makeMockContext();

describe('executeTool', () => {
  it('calls tool.execute() and returns typed output', async () => {
    const tool = {
      name: 'add',
      description: 'Add two numbers',
      input: z.object({
        a: z.number(),
        b: z.number(),
      }),
      output: z.object({
        sum: z.number(),
      }),
      execute: async (args: { a: number; b: number }) => ({
        sum: args.a + args.b,
      }),
    };
    const s: StepTool<
      {
        a: number;
        b: number;
      },
      {
        sum: number;
      }
    > = {
      kind: 'tool',
      id: 'add-test',
      tool,
    };
    const result = await executeTool(
      s,
      {
        a: 3,
        b: 4,
      },
      mockCtx,
    );
    expect(result).toEqual({
      sum: 7,
    });
  });

  it('validates input against Zod schema', async () => {
    const tool = {
      name: 'greet',
      description: 'Greet',
      input: z.object({
        name: z.string(),
      }),
      output: z.object({
        greeting: z.string(),
      }),
      execute: async (args: { name: string }) => ({
        greeting: `Hi ${args.name}`,
      }),
    };
    // Cast via unknown to pass invalid input for runtime validation testing
    type GreetInput = {
      name: string;
    };
    const s: StepTool<
      GreetInput,
      {
        greeting: string;
      }
    > = {
      kind: 'tool',
      id: 'greet-test',
      tool,
    };
    const badInput = {
      name: 123,
    } as unknown as GreetInput;

    try {
      await executeTool(s, badInput, mockCtx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isOrchidError(e));
      expect(e.orchidError.kind).toBe('step_failed');
    }
  });

  it('merges step.args with input', async () => {
    let receivedArgs:
      | {
          query: string;
          limit: number;
        }
      | undefined;
    const tool = {
      name: 'search',
      description: 'Search',
      input: z.object({
        query: z.string(),
        limit: z.number(),
      }),
      output: z.object({
        results: z.array(z.string()),
      }),
      execute: async (args: { query: string; limit: number }) => {
        receivedArgs = args;
        return {
          results: [],
        };
      },
    };
    const s: StepTool<
      {
        query: string;
        limit: number;
      },
      {
        results: string[];
      }
    > = {
      kind: 'tool',
      id: 'search-test',
      tool,
      args: {
        limit: 5,
      },
    };
    await executeTool(
      s,
      {
        query: 'test',
        limit: 10,
      },
      mockCtx,
    );
    expect(receivedArgs?.query).toBe('test');
    expect(receivedArgs?.limit).toBe(5); // step.args overrides
  });

  it('passes context to tool.execute', async () => {
    let receivedCtx: ReturnType<typeof makeMockContext> | undefined;
    const tool = {
      name: 'ctx-test',
      description: 'Test',
      input: z.object({}),
      output: z.string(),
      execute: async (_args: Record<string, never>, ctx: ReturnType<typeof makeMockContext>) => {
        receivedCtx = ctx;
        return 'ok';
      },
    };
    const s: StepTool<Record<string, never>, string> = {
      kind: 'tool',
      id: 'ctx-test',
      tool,
    };
    await executeTool(s, {}, mockCtx);
    expect(receivedCtx).toBe(mockCtx);
  });

  it('wraps tool execution errors in step_failed', async () => {
    const tool = {
      name: 'failing',
      description: 'Fails',
      input: z.object({}),
      output: z.string(),
      execute: async () => {
        throw new Error('tool broke');
      },
    };
    const s: StepTool<Record<string, never>, string> = {
      kind: 'tool',
      id: 'fail-test',
      tool,
    };

    try {
      await executeTool(s, {}, mockCtx);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isOrchidError(e));
      const oe = e.orchidError;
      assert(oe.kind === 'step_failed');
      expect(oe.cause.message).toBe('tool broke');
    }
  });
});
