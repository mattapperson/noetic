import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { isNoeticError } from '../../src/errors/noetic-error';
import { allocateBudgets, checkBudget } from '../../src/memory/budget';
import { ContextImpl } from '../../src/runtime/context-impl';
import type { BudgetConfig, MemoryLayer } from '../../src/types/memory';
import { Slot } from '../../src/types/memory';
import { makeMockHarness } from '../_helpers';

function makeLayer(id: string, budget: BudgetConfig): MemoryLayer {
  return {
    id,
    name: id,
    slot: Slot.WORKING_MEMORY,
    scope: 'thread',
    budget,
    hooks: {},
  };
}

describe('allocateBudgets', () => {
  it('satisfies minimums first', () => {
    const layers = [
      makeLayer('a', {
        min: 200,
        max: 1_000,
      }),
      makeLayer('b', {
        min: 300,
        max: 1_000,
      }),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 10_000,
      systemPromptTokens: 500,
      responseReserve: 1_000,
    });
    expect(allocations[0].allocated).toBeGreaterThanOrEqual(200);
    expect(allocations[1].allocated).toBeGreaterThanOrEqual(300);
  });

  it('reserves 40% for history', () => {
    const layers = [
      makeLayer('a', {
        min: 0,
        max: 5_000,
      }),
    ];
    const { historyBudget } = allocateBudgets({
      layers,
      totalBudget: 10_000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    expect(historyBudget).toBe(4_000);
  });

  it('handles zero available budget', () => {
    const layers = [
      makeLayer('a', {
        min: 200,
        max: 1_000,
      }),
    ];
    const { allocations, historyBudget } = allocateBudgets({
      layers,
      totalBudget: 100,
      systemPromptTokens: 50,
      responseReserve: 50,
    });
    expect(allocations[0].allocated).toBe(0);
    expect(historyBudget).toBe(0);
  });

  it('distributes proportionally to max headroom', () => {
    const layers = [
      makeLayer('a', {
        min: 0,
        max: 3_000,
      }),
      makeLayer('b', {
        min: 0,
        max: 1_000,
      }),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 10_000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    // 60% of 10000 = 6000 for layers; a gets 3/4 = 4500 capped to 3000, b gets 1/4 = 1500 capped to 1000
    expect(allocations[0].allocated).toBe(3_000);
    expect(allocations[1].allocated).toBe(1_000);
  });

  it('handles numeric budget config', () => {
    const layers = [
      makeLayer('a', 500),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 10_000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    expect(allocations[0].allocated).toBe(500);
  });

  it('Infinity headroom layers split equally', () => {
    const layers = [
      makeLayer('a', 'auto'),
      makeLayer('b', 'auto'),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 10_000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    // 60% of 10000 = 6000 for layers, split equally between 2 auto layers
    expect(allocations[0].allocated).toBe(3_000);
    expect(allocations[1].allocated).toBe(3_000);
  });

  it('negative available budget yields all zero allocations', () => {
    const layers = [
      makeLayer('a', {
        min: 200,
        max: 1_000,
      }),
      makeLayer('b', 'auto'),
    ];
    // systemPromptTokens + responseReserve > totalBudget
    const { allocations, historyBudget } = allocateBudgets({
      layers,
      totalBudget: 100,
      systemPromptTokens: 5_000,
      responseReserve: 5_000,
    });
    expect(allocations[0].allocated).toBe(0);
    expect(allocations[1].allocated).toBe(0);
    expect(historyBudget).toBe(0);
  });

  it('handles auto budget config', () => {
    const layers = [
      makeLayer('a', 'auto'),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 10_000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    // 60% of 10000 (layerPool ratio) allocated to single auto layer
    expect(allocations[0].allocated).toBe(6_000);
  });
});

describe('checkBudget', () => {
  it('throws budget_exceeded for cost', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    ctx.cost = 10.0;
    try {
      checkBudget(ctx, {
        maxCost: 5.0,
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      const oe = e.noeticError;
      assert(oe.kind === 'budget_exceeded');
      expect(oe.field).toBe('cost');
      expect(oe.limit).toBe(5.0);
      expect(oe.actual).toBe(10.0);
    }
  });

  it('throws budget_exceeded for steps', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    ctx.stepCount = 100;
    try {
      checkBudget(ctx, {
        maxSteps: 50,
      });
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      const oe = e.noeticError;
      assert(oe.kind === 'budget_exceeded');
      expect(oe.field).toBe('steps');
    }
  });

  it('throws budget_exceeded for duration', async () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    // Wait a bit so elapsed > 0
    await new Promise((r) => setTimeout(r, 20));
    try {
      checkBudget(ctx, {
        maxDuration: 1,
      }); // 1ms limit, elapsed should be > 1ms
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      const oe = e.noeticError;
      assert(oe.kind === 'budget_exceeded');
      expect(oe.field).toBe('duration');
    }
  });

  it('does not throw when within budget', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    expect(() =>
      checkBudget(ctx, {
        maxCost: 100,
        maxSteps: 100,
        maxDuration: 60_000,
      }),
    ).not.toThrow();
  });

  it('checks only specified limits', () => {
    const ctx = new ContextImpl({
      harness: makeMockHarness(),
    });
    ctx.cost = 999;
    // Only checking steps, not cost
    expect(() =>
      checkBudget(ctx, {
        maxSteps: 1_000,
      }),
    ).not.toThrow();
  });
});
