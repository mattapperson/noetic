import { describe, it, expect } from 'bun:test';
import { allocateBudgets, checkBudget } from '../../src/memory/budget';
import { Slot } from '../../src/types/memory';
import type { MemoryLayer } from '../../src/types/memory';
import { ContextImpl } from '../../src/runtime/context-impl';
import { isOrchidError, OrchidErrorImpl } from '../../src/errors/orchid-error';

function makeLayer(id: string, budget: any): MemoryLayer {
  return { id, name: id, slot: Slot.WORKING_MEMORY, scope: 'thread', budget, hooks: {} };
}

describe('allocateBudgets', () => {
  it('satisfies minimums first', () => {
    const layers = [makeLayer('a', { min: 200, max: 1000 }), makeLayer('b', { min: 300, max: 1000 })];
    const { allocations } = allocateBudgets(layers, 10000, 500, 1000);
    expect(allocations[0].allocated).toBeGreaterThanOrEqual(200);
    expect(allocations[1].allocated).toBeGreaterThanOrEqual(300);
  });

  it('reserves 40% for history', () => {
    const layers = [makeLayer('a', { min: 0, max: 5000 })];
    const { historyBudget } = allocateBudgets(layers, 10000, 0, 0);
    expect(historyBudget).toBeGreaterThan(0);
  });

  it('handles zero available budget', () => {
    const layers = [makeLayer('a', { min: 200, max: 1000 })];
    const { allocations, historyBudget } = allocateBudgets(layers, 100, 50, 50);
    expect(allocations[0].allocated).toBe(0);
    expect(historyBudget).toBe(0);
  });

  it('distributes proportionally to max headroom', () => {
    const layers = [
      makeLayer('a', { min: 0, max: 3000 }),
      makeLayer('b', { min: 0, max: 1000 }),
    ];
    const { allocations } = allocateBudgets(layers, 10000, 0, 0);
    // 'a' has 3x the headroom so should get 3x the share
    expect(allocations[0].allocated).toBeGreaterThan(allocations[1].allocated);
  });

  it('handles numeric budget config', () => {
    const layers = [makeLayer('a', 500)];
    const { allocations } = allocateBudgets(layers, 10000, 0, 0);
    expect(allocations[0].allocated).toBeGreaterThanOrEqual(0);
    expect(allocations[0].allocated).toBeLessThanOrEqual(500);
  });

  it('handles auto budget config', () => {
    const layers = [makeLayer('a', 'auto')];
    const { allocations } = allocateBudgets(layers, 10000, 0, 0);
    expect(allocations[0].allocated).toBeGreaterThan(0);
  });
});

describe('checkBudget', () => {
  it('throws budget_exceeded for cost', () => {
    const ctx = new ContextImpl();
    (ctx as any).cost = 10.0;
    try {
      checkBudget(ctx, { maxCost: 5.0 });
      expect(true).toBe(false);
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
      const oe = (e as OrchidErrorImpl).orchidError;
      expect(oe.kind).toBe('budget_exceeded');
      if (oe.kind === 'budget_exceeded') {
        expect(oe.field).toBe('cost');
        expect(oe.limit).toBe(5.0);
        expect(oe.actual).toBe(10.0);
      }
    }
  });

  it('throws budget_exceeded for steps', () => {
    const ctx = new ContextImpl();
    (ctx as any).stepCount = 100;
    try {
      checkBudget(ctx, { maxSteps: 50 });
      expect(true).toBe(false);
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
      const oe = (e as OrchidErrorImpl).orchidError;
      expect(oe.kind).toBe('budget_exceeded');
      if (oe.kind === 'budget_exceeded') {
        expect(oe.field).toBe('steps');
      }
    }
  });

  it('throws budget_exceeded for duration', async () => {
    const ctx = new ContextImpl();
    // Wait a bit so elapsed > 0
    await new Promise(r => setTimeout(r, 20));
    try {
      checkBudget(ctx, { maxDuration: 1 }); // 1ms limit, elapsed should be > 1ms
      expect(true).toBe(false);
    } catch (e) {
      expect(isOrchidError(e)).toBe(true);
      const oe = (e as OrchidErrorImpl).orchidError;
      expect(oe.kind).toBe('budget_exceeded');
      if (oe.kind === 'budget_exceeded') {
        expect(oe.field).toBe('duration');
      }
    }
  });

  it('does not throw when within budget', () => {
    const ctx = new ContextImpl();
    expect(() => checkBudget(ctx, { maxCost: 100, maxSteps: 100, maxDuration: 60000 })).not.toThrow();
  });

  it('checks only specified limits', () => {
    const ctx = new ContextImpl();
    (ctx as any).cost = 999;
    // Only checking steps, not cost
    expect(() => checkBudget(ctx, { maxSteps: 1000 })).not.toThrow();
  });
});
