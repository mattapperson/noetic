import { describe, expect, it } from 'bun:test';
import type { ExtendedItem } from '@noetic-tools/types';
import { z } from 'zod';
import type {
  ConditionalOpts,
  InParallelOpts,
  MergeFn,
  PendingSpend,
  SettleResult,
  Step,
  StepSpawn,
} from '../../src/index';
import { conditional, inParallel, invokeTool, runCode, Slot, tool } from '../../src/index';

describe('Type definitions', () => {
  describe('Memory types', () => {
    it('Slot constants have correct values', () => {
      expect(Slot.WORKING_MEMORY).toBe(100);
      expect(Slot.ENTITY).toBe(150);
      expect(Slot.OBSERVATIONS).toBe(200);
      expect(Slot.PROCEDURAL).toBe(250);
      expect(Slot.EPISODIC).toBe(300);
      expect(Slot.RAG).toBe(350);
      expect(Slot.SEMANTIC_RECALL).toBe(400);
    });
  });

  describe('SettleResult', () => {
    it('has fulfilled and rejected variants with correct fields', () => {
      const fulfilled: SettleResult<string> = {
        stepId: 's1',
        status: 'fulfilled',
        value: 'result',
      };
      const rejected: SettleResult<string> = {
        stepId: 's2',
        status: 'rejected',
        error: {
          kind: 'cancelled',
          reason: 'test',
        },
      };
      expect(fulfilled.status).toBe('fulfilled');
      expect(fulfilled.value).toBe('result');
      expect(rejected.status).toBe('rejected');
      expect(rejected.error!.kind).toBe('cancelled');
    });
  });

  describe('ExtendedItem', () => {
    it('accepts schema-inferred custom items', () => {
      const CustomItemSchema = z.object({
        type: z.literal('custom:test'),
        id: z.string(),
        payload: z.number(),
      });
      const extensions = {
        items: [
          CustomItemSchema,
        ],
      } as const;
      const item: ExtendedItem<typeof extensions> = {
        type: 'custom:test',
        id: 'custom-1',
        payload: 1,
      };

      expect(item.payload).toBe(1);
    });
  });

  describe('Control-flow option types', () => {
    const echo = runCode<unknown, string, string>({
      id: 'echo',
      execute: async (input) => input,
    });

    it('builds typed inParallel options for each mode', () => {
      const race: InParallelOpts<unknown, string, string> = {
        id: 'race',
        mode: 'race',
        paths: () => [
          echo,
        ],
      };
      const joinAll: MergeFn<unknown, string> = (results) => results.join(',');
      const all: InParallelOpts<unknown, string, string> = {
        id: 'all',
        mode: 'all',
        paths: () => [
          echo,
        ],
        merge: joinAll,
      };
      const joinSettled: MergeFn<unknown, string, SettleResult<string>> = (results) =>
        results.map((r) => r.value ?? '').join(',');
      const settle: InParallelOpts<unknown, string, string> = {
        id: 'settle',
        mode: 'settle',
        paths: () => [
          echo,
        ],
        merge: joinSettled,
      };

      expect(inParallel(race).mode).toBe('race');
      expect(inParallel(all).mode).toBe('all');
      expect(inParallel(settle).mode).toBe('settle');
    });

    it('requires merge for all and settle, typed per mode', () => {
      // @ts-expect-error merge is required in 'all' mode
      const all: InParallelOpts<unknown, string, string> = {
        id: 'all',
        mode: 'all',
        paths: () => [
          echo,
        ],
      };
      // @ts-expect-error merge is required in 'settle' mode
      const settle: InParallelOpts<unknown, string, string> = {
        id: 'settle',
        mode: 'settle',
        paths: () => [
          echo,
        ],
      };
      const wrongMerge: InParallelOpts<unknown, string, string> = {
        id: 'settle-wrong',
        mode: 'settle',
        paths: () => [
          echo,
        ],
        // @ts-expect-error settle merge receives SettleResult<O>[], not O[]
        merge: (results: string[]) => results.join(','),
      };

      expect(all.mode).toBe('all');
      expect(settle.mode).toBe('settle');
      expect(wrongMerge.mode).toBe('settle');
    });

    it('builds typed conditional options', () => {
      const opts: ConditionalOpts<unknown, string, string> = {
        id: 'route',
        route: (input) => (input === 'skip' ? null : echo),
      };

      expect(conditional(opts).kind).toBe('conditional');
    });
  });

  describe('invokeTool args', () => {
    const add = tool({
      name: 'add',
      description: 'Add two numbers',
      input: z.object({
        a: z.number(),
        b: z.number(),
      }),
      output: z.number(),
      execute: async ({ a, b }) => a + b,
    });

    it('accepts a partial of the tool input', () => {
      const s = invokeTool({
        id: 'add-partial',
        tool: add,
        args: {
          a: 1,
        },
      });

      expect(s.args).toEqual({
        a: 1,
      });
    });

    it('rejects keys outside the tool input', () => {
      const s = invokeTool({
        id: 'add-extra',
        tool: add,
        args: {
          a: 1,
          // @ts-expect-error `c` is not a key of the tool input
          c: 2,
        },
      });

      expect(s.kind).toBe('invokeTool');
    });
  });

  // Regression: `StepSpawn` was accidentally dropped from `@noetic-tools/core`'s
  // public re-export block during a step-kind merge (only the new step type
  // was added next to it). Doc snippets that import it via `@noetic-tools/core`
  // — and any downstream consumer that does the same — broke. This is a
  // typecheck-level assertion: if the re-export disappears again, tsc fails on
  // the `Step` narrowing below.
  describe('Public step-type re-exports', () => {
    it('exposes StepSpawn from @noetic-tools/core', () => {
      function isSpawn<TContext, I, O>(s: Step<TContext, I, O>): s is StepSpawn<TContext, I, O> {
        return s.kind === 'spawn';
      }
      // Use the predicate so the import is not elided as type-only.
      expect(typeof isSpawn).toBe('function');
    });
  });

  // Host code written against `PendingSpend` before unreadable records were listed
  // must still compile: every field it read stays on the type, with the same type.
  describe('PendingSpend', () => {
    it('keeps the fields hosts read, with an optional unreadable flag', () => {
      function describeHold(p: PendingSpend): string {
        const kind: 'model' | 'decide' = p.kind;
        const model: string = p.model;
        const ceiling: number | undefined = p.ceiling;
        const sent: number = Date.parse(p.sentAt);
        return `${kind} ${model} ${ceiling ?? 'unbounded'} ${sent} ${p.inputTokens}`;
      }
      const damaged: PendingSpend = {
        id: 'x',
        unreadable: true,
        kind: 'model',
        model: 'unknown',
        requestHash: '',
        inputTokens: 0,
        sentAt: new Date(0).toISOString(),
      };

      expect(describeHold(damaged)).toBe('model unknown unbounded 0 0');
    });
  });
});
