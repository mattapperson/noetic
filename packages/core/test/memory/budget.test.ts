import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { BudgetConfig, MemoryLayer } from '@noetic-tools/memory';
import { allocateBudgets, checkBudget, Slot } from '@noetic-tools/memory';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { ContextImpl } from '../../src/runtime/context-impl';
import { makeMockHarness } from '../_helpers';

function makeLayer(id: string, budget?: BudgetConfig): MemoryLayer {
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

  it('a layer that omits budget gets an auto share, not 0', () => {
    const layers = [
      makeLayer('no-budget'),
      makeLayer('auto', 'auto'),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 10_000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    // Omitted budget = infinite headroom: splits the 6000 pool with 'auto'.
    expect(allocations[0].allocated).toBe(3_000);
    expect(allocations[1].allocated).toBe(3_000);
  });

  it('conserves the pool when finite and auto layers mix (verifier repro)', () => {
    const layers = [
      makeLayer('finite', {
        min: 0,
        max: 4_800,
      }),
      makeLayer('auto', 'auto'),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 10_000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    // layerPool = 6000; finite gets min(4800, half-pool 3000) = 3000;
    // auto gets the REST of the pool — nothing vanishes.
    expect(allocations[0].allocated).toBe(3_000);
    expect(allocations[1].allocated).toBe(3_000);
    const sum = allocations.reduce((s, a) => s + a.allocated, 0);
    expect(sum).toBe(6_000);
  });

  it.each([
    // [finiteMax, expectedFinite, expectedAuto] — half-pool clamp boundary at 3000
    [
      2_999,
      2_999,
      3_001,
    ],
    [
      3_000,
      3_000,
      3_000,
    ],
    [
      3_001,
      3_000,
      3_000,
    ],
  ])('clamp switchover boundary: finite max %d → finite %d / auto %d (pool conserved)', (finiteMax, expectedFinite, expectedAuto) => {
    const layers = [
      makeLayer('finite', {
        min: 0,
        max: finiteMax,
      }),
      makeLayer('auto', 'auto'),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 10_000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    expect(allocations[0].allocated).toBeCloseTo(expectedFinite, 6);
    expect(allocations[1].allocated).toBeCloseTo(expectedAuto, 6);
    const sum = allocations.reduce((s, a) => s + a.allocated, 0);
    expect(sum).toBeCloseTo(6_000, 6);
  });

  it.each([
    'totalBudget',
    'systemPromptTokens',
    'responseReserve',
  ] as const)('NaN %s throws NoeticConfigError INVALID_BUDGET_INPUT', (field) => {
    const opts = {
      layers: [
        makeLayer('a', 'auto'),
      ],
      totalBudget: 10_000,
      systemPromptTokens: 0,
      responseReserve: 0,
      [field]: Number.NaN,
    };
    try {
      allocateBudgets(opts);
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('INVALID_BUDGET_INPUT');
      expect(e.message).toContain(field);
    }
  });

  it('Infinity totalBudget is allowed (= uncapped): no NaN anywhere', () => {
    const layers = [
      makeLayer('finite', {
        min: 100,
        max: 1_000,
      }),
      makeLayer('auto', 'auto'),
    ];
    const { allocations, historyBudget } = allocateBudgets({
      layers,
      totalBudget: Number.POSITIVE_INFINITY,
      systemPromptTokens: 0,
      responseReserve: 4_000,
    });
    for (const a of allocations) {
      expect(Number.isNaN(a.allocated)).toBe(false);
    }
    expect(allocations[0].allocated).toBe(1_000); // capped at max
    expect(allocations[1].allocated).toBe(Number.POSITIVE_INFINITY);
    expect(historyBudget).toBe(Number.POSITIVE_INFINITY);
  });

  it('fractional budgets are accepted (pinned)', () => {
    const layers = [
      makeLayer('auto', 'auto'),
    ];
    const { allocations, historyBudget } = allocateBudgets({
      layers,
      totalBudget: 0.5,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    expect(allocations[0].allocated).toBeCloseTo(0.3, 9);
    expect(historyBudget).toBeCloseTo(0.2, 9);
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
