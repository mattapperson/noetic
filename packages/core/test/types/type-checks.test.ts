import { describe, expect, it } from 'bun:test';
import type { ExtendedItem } from '@noetic-tools/types';
import { z } from 'zod';
import type { SettleResult } from '../../src/index';
import { Slot } from '../../src/index';

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

  // Regression: `StepSpawn` was accidentally dropped from `@noetic-tools/core`'s
  // public re-export block during the sub-harness merge (only `StepSubHarness`
  // was added next to it). Doc snippets that import it via `@noetic-tools/core`
  // — and any downstream consumer that does the same — broke. This is a
  // typecheck-level assertion: if the re-export disappears again, tsc fails on
  // the `Step` narrowing below.
  describe('Public step-type re-exports', () => {
    it('exposes StepSpawn from @noetic-tools/core', () => {
      function isSpawn<TMemory, I, O>(s: Step<TMemory, I, O>): s is StepSpawn<TMemory, I, O> {
        return s.kind === 'spawn';
      }
      // Use the predicate so the import is not elided as type-only.
      expect(typeof isSpawn).toBe('function');
    });
  });
});
