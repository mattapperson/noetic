import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { isNoeticError } from '../../src/errors/noetic-error';
import { executeSpawn } from '../../src/interpreter/execute-spawn';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { Context } from '../../src/types/context';
import type { Item, MessageItem } from '../../src/types/items';
import type { StepSpawn } from '../../src/types/step';
import { simpleExecute } from '../_helpers';

describe('executeSpawn', () => {
  describe('contextIn: inherit', () => {
    it('copies parent ItemLog items to child', async () => {
      const parentCtx = new ContextImpl();
      const parentItem: MessageItem = {
        id: 'p1',
        status: 'completed',
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'hello',
          },
        ],
      };
      parentCtx.itemLog.append(parentItem);

      let childItemCount = 0;
      const step: StepSpawn<string, string> = {
        kind: 'spawn',
        id: 'test',
        child: {
          kind: 'run',
          id: 'child-run',
          execute: async (_: string, ctx: Context) => {
            childItemCount = ctx.itemLog.items.length;
            return 'done';
          },
        },
        contextIn: {
          strategy: 'inherit',
        },
        contextOut: {
          strategy: 'full',
        },
      };

      await executeSpawn(step, 'input', parentCtx, simpleExecute);
      expect(childItemCount).toBe(1); // inherited parent's item
    });
  });

  describe('contextIn: fresh', () => {
    it('starts with empty ItemLog', async () => {
      const parentCtx = new ContextImpl();
      const freshItem: MessageItem = {
        id: 'p1',
        status: 'completed',
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'hello',
          },
        ],
      };
      parentCtx.itemLog.append(freshItem);

      let childItemCount = -1;
      const step: StepSpawn<string, string> = {
        kind: 'spawn',
        id: 'test',
        child: {
          kind: 'run',
          id: 'child-run',
          execute: async (_: string, ctx: Context) => {
            childItemCount = ctx.itemLog.items.length;
            return 'done';
          },
        },
        contextIn: {
          strategy: 'fresh',
        },
        contextOut: {
          strategy: 'full',
        },
      };

      await executeSpawn(step, 'input', parentCtx, simpleExecute);
      expect(childItemCount).toBe(0); // fresh = empty
    });
  });

  describe('contextIn: subset', () => {
    it('filters parent items via selector', async () => {
      const parentCtx = new ContextImpl();
      const userItem: MessageItem = {
        id: 'p1',
        status: 'completed',
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'hello',
          },
        ],
      };
      const assistantItem: MessageItem = {
        id: 'p2',
        status: 'completed',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'hi',
          },
        ],
      };
      parentCtx.itemLog.append(userItem);
      parentCtx.itemLog.append(assistantItem);

      let childItems: readonly Item[] = [];
      const step: StepSpawn<string, string> = {
        kind: 'spawn',
        id: 'test',
        child: {
          kind: 'run',
          id: 'child-run',
          execute: async (_: string, ctx: Context) => {
            childItems = ctx.itemLog.items;
            return 'done';
          },
        },
        contextIn: {
          strategy: 'subset',
          select: (items) =>
            items.filter(
              (i): i is MessageItem => i.type === 'message' && (i as MessageItem).role === 'user',
            ),
        },
        contextOut: {
          strategy: 'full',
        },
      };

      await executeSpawn(step, 'input', parentCtx, simpleExecute);
      expect(childItems).toHaveLength(1);
    });
  });

  describe('contextIn: custom', () => {
    it('builds arbitrary items', async () => {
      const parentCtx = new ContextImpl();
      let childItems: readonly Item[] = [];
      const step: StepSpawn<string, string> = {
        kind: 'spawn',
        id: 'test',
        child: {
          kind: 'run',
          id: 'child-run',
          execute: async (_: string, ctx: Context) => {
            childItems = ctx.itemLog.items;
            return 'done';
          },
        },
        contextIn: {
          strategy: 'custom',
          build: (input, _parentCtx): MessageItem[] => [
            {
              id: 'custom-1',
              status: 'completed',
              type: 'message',
              role: 'system',
              content: [
                {
                  type: 'input_text',
                  text: `Custom: ${input}`,
                },
              ],
            },
          ],
        },
        contextOut: {
          strategy: 'full',
        },
      };

      await executeSpawn(step, 'hello', parentCtx, simpleExecute);
      expect(childItems).toHaveLength(1);
      const firstItem = childItems[0] as MessageItem;
      expect(firstItem.content[0]).toEqual({
        type: 'input_text',
        text: 'Custom: hello',
      });
    });
  });

  describe('state isolation', () => {
    it('child gets deep-cloned state', async () => {
      type TestState = {
        count: number;
        nested: {
          val: string;
        };
      };
      const parentCtx = new ContextImpl({
        state: {
          count: 0,
          nested: {
            val: 'original',
          },
        } satisfies TestState,
      });

      const step: StepSpawn<string, string> = {
        kind: 'spawn',
        id: 'test',
        child: {
          kind: 'run',
          id: 'child-run',
          // Spawn provides child contexts; state is writable via Context interface
          execute: async (_: string, ctx: Context) => {
            const childState = ctx.state as TestState;
            childState.count = 99;
            childState.nested.val = 'modified';
            return 'done';
          },
        },
        contextIn: {
          strategy: 'fresh',
        },
        contextOut: {
          strategy: 'full',
        },
      };

      await executeSpawn(step, '', parentCtx, simpleExecute);
      // Parent state should be unchanged
      const parentState = parentCtx.state as TestState;
      expect(parentState.count).toBe(0);
      expect(parentState.nested.val).toBe('original');
    });
  });

  describe('depth', () => {
    it('child depth increments', async () => {
      const parentCtx = new ContextImpl();
      let childDepth = -1;

      const step: StepSpawn<string, string> = {
        kind: 'spawn',
        id: 'test',
        child: {
          kind: 'run',
          id: 'child-run',
          execute: async (_: string, ctx: Context) => {
            childDepth = ctx.depth;
            return 'done';
          },
        },
        contextIn: {
          strategy: 'fresh',
        },
        contextOut: {
          strategy: 'full',
        },
      };

      await executeSpawn(step, '', parentCtx, simpleExecute);
      expect(parentCtx.depth).toBe(0);
      expect(childDepth).toBe(1);
    });
  });

  describe('child step throws', () => {
    it('error propagates from executeSpawn', async () => {
      const parentCtx = new ContextImpl();
      const step: StepSpawn<string, string> = {
        kind: 'spawn',
        id: 'throw-test',
        child: {
          kind: 'run',
          id: 'child-run',
          execute: async () => {
            throw new Error('child boom');
          },
        },
        contextIn: {
          strategy: 'fresh',
        },
        contextOut: {
          strategy: 'full',
        },
      };
      await expect(executeSpawn(step, '', parentCtx, simpleExecute)).rejects.toThrow('child boom');
    });
  });

  describe('contextIn: subset with empty parent', () => {
    it('select receives empty array', async () => {
      const parentCtx = new ContextImpl();
      let receivedItems: readonly Item[] = [];
      const step: StepSpawn<string, string> = {
        kind: 'spawn',
        id: 'empty-subset',
        child: {
          kind: 'run',
          id: 'child-run',
          execute: async () => 'done',
        },
        contextIn: {
          strategy: 'subset',
          select: (items) => {
            receivedItems = items;
            return [];
          },
        },
        contextOut: {
          strategy: 'full',
        },
      };
      await executeSpawn(step, '', parentCtx, simpleExecute);
      expect(receivedItems).toHaveLength(0);
    });
  });

  describe('contextOut: schema validation failure', () => {
    it('throws llm_parse_error on schema mismatch', async () => {
      const parentCtx = new ContextImpl();
      type SchemaOutOpts = Parameters<typeof executeSpawn>[0];
      // Intentionally pass z.number() schema against a string output to trigger
      // the runtime parse failure path — bypasses generic type constraint via unknown.
      const step = {
        kind: 'spawn' as const,
        id: 'schema-fail',
        child: {
          kind: 'run' as const,
          id: 'child-run',
          execute: async () => 'not-a-number',
        },
        contextIn: {
          strategy: 'fresh' as const,
        },
        contextOut: {
          strategy: 'schema' as const,
          schema: z.number(),
        },
      } as unknown as SchemaOutOpts;
      try {
        await executeSpawn(step, '', parentCtx, simpleExecute);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        expect(e.noeticError.kind).toBe('llm_parse_error');
      }
    });
  });

  describe('contextOut: summary when callModel fails', () => {
    it('throws spawn_summary_failed with childOutput', async () => {
      const parentCtx = new ContextImpl();
      const step: StepSpawn<string, string> = {
        kind: 'spawn',
        id: 'sum-fail',
        child: {
          kind: 'run',
          id: 'child-run',
          execute: async () => 'child-data',
        },
        contextIn: {
          strategy: 'fresh',
        },
        contextOut: {
          strategy: 'summary',
        },
      };
      const failingCallModel = async () => {
        throw new Error('LLM down');
      };
      try {
        await executeSpawn(step, '', parentCtx, simpleExecute, failingCallModel);
        expect.unreachable('should have thrown');
      } catch (e) {
        assert(isNoeticError(e));
        const oe = e.noeticError;
        assert(oe.kind === 'spawn_summary_failed');
        expect(oe.childOutput).toBe('child-data');
      }
    });
  });

  describe('contextOut: full', () => {
    it('returns child output directly', async () => {
      const parentCtx = new ContextImpl();
      const step: StepSpawn<string, number> = {
        kind: 'spawn',
        id: 'test',
        child: {
          kind: 'run',
          id: 'child-run',
          execute: async (input: string) => input.length,
        },
        contextIn: {
          strategy: 'fresh',
        },
        contextOut: {
          strategy: 'full',
        },
      };

      const result = await executeSpawn(step, 'hello', parentCtx, simpleExecute);
      expect(result).toBe(5);
    });
  });
});
