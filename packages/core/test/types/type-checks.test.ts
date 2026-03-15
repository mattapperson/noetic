import { describe, expect, it } from 'bun:test';
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
});
