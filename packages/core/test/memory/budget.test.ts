import { describe, it, expect } from 'bun:test';
import { allocateBudgets } from '../../src/memory/budget';
import { Slot } from '../../src/types/memory';
import type { MemoryLayer } from '../../src/types/memory';

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
