import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type { StepInvokeTool, ToolExecutionContext } from '@noetic-tools/types';
import { frameworkCast, isNoeticError } from '@noetic-tools/types';
import { z } from 'zod';
import { executeInvokeTool } from '../../src/interpreter/execute-action';
import { makeMockContext, makeMockHarness } from '../_helpers';

const mockCtx = makeMockContext();
const mockHarness = makeMockHarness();

describe('executeInvokeTool', () => {
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
    const s: StepInvokeTool<
      ContextData,
      {
        a: number;
        b: number;
      },
      {
        sum: number;
      }
    > = {
      kind: 'invokeTool',
      id: 'add-test',
      tool,
    };
    const result = await executeInvokeTool(
      s,
      {
        a: 3,
        b: 4,
      },
      mockCtx,
      mockHarness,
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
    const s: StepInvokeTool<
      ContextData,
      GreetInput,
      {
        greeting: string;
      }
    > = {
      kind: 'invokeTool',
      id: 'greet-test',
      tool,
    };
    const badInput = frameworkCast<GreetInput>({
      name: 123,
    });

    try {
      await executeInvokeTool(s, badInput, mockCtx, mockHarness);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('step_failed');
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
    const s: StepInvokeTool<
      ContextData,
      {
        query: string;
        limit: number;
      },
      {
        results: string[];
      }
    > = {
      kind: 'invokeTool',
      id: 'search-test',
      tool,
      args: {
        limit: 5,
      },
    };
    await executeInvokeTool(
      s,
      {
        query: 'test',
        limit: 10,
      },
      mockCtx,
      mockHarness,
    );
    expect(receivedArgs?.query).toBe('test');
    expect(receivedArgs?.limit).toBe(5); // step.args overrides
  });

  it('passes ToolExecutionContext to tool.execute', async () => {
    let receivedToolCtx: ToolExecutionContext | undefined;
    const tool = {
      name: 'ctx-test',
      description: 'Test',
      input: z.object({}),
      output: z.string(),
      execute: async (_args: Record<string, never>, toolCtx: ToolExecutionContext) => {
        receivedToolCtx = toolCtx;
        return 'ok';
      },
    };
    const s: StepInvokeTool<ContextData, Record<string, never>, string> = {
      kind: 'invokeTool',
      id: 'ctx-test',
      tool,
    };
    await executeInvokeTool(s, {}, mockCtx, mockHarness);
    assert(receivedToolCtx !== undefined);
    expect(receivedToolCtx.ctx).toBe(mockCtx);
    expect(receivedToolCtx.context).toBeDefined();
    expect(receivedToolCtx.assembledView).toBeDefined();
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
    const s: StepInvokeTool<ContextData, Record<string, never>, string> = {
      kind: 'invokeTool',
      id: 'fail-test',
      tool,
    };

    try {
      await executeInvokeTool(s, {}, mockCtx, mockHarness);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      const oe = e.noeticError;
      assert(oe.kind === 'step_failed');
      expect(oe.cause.message).toBe('tool broke');
    }
  });
});
