import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { BudgetConfig, ContextLayer } from '@noetic-tools/context';
import { allocateBudgets, checkBudget, Slot } from '@noetic-tools/context';
import { isNoeticConfigError, isNoeticError } from '@noetic-tools/types';
import { ContextImpl } from '../../src/runtime/context-impl';
import { makeMockHarness } from '../_helpers';

function makeLayer(id: string, budget?: BudgetConfig): ContextLayer {
  return {
    id,
    name: id,
    slot: Slot.WORKING_MEMORY,
    scope: 'thread',
    budget,
    hooks: {},
  };
}

// The layer pool is 25% of (totalBudget - responseReserve - systemPromptTokens).
// History no longer takes a per-turn budget line from the allocator: what the
// assembler can fit is decided in assembleView, and compaction is how history
// shrinks (see historyPressure).
const POOL_SHARE = 0.25;
// Cap assigned to 'auto'/omitted budgets — deterministic, not infinite.
const AUTO_CAP = 2_000;

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

  it('handles zero available budget', () => {
    const layers = [
      makeLayer('a', {
        min: 200,
        max: 1_000,
      }),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 100,
      systemPromptTokens: 50,
      responseReserve: 50,
    });
    expect(allocations[0].allocated).toBe(0);
  });

  it('distributes proportionally to cap headroom, clamped to caps', () => {
    const layers = [
      makeLayer('a', {
        min: 0,
        max: 300,
      }),
      makeLayer('b', {
        min: 0,
        max: 100,
      }),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 10_000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    // pool = 2500; headrooms 300/100 → both fully satisfiable within the pool.
    expect(allocations[0].allocated).toBe(300);
    expect(allocations[1].allocated).toBe(100);
  });

  it('handles numeric budget config as a cap', () => {
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

  it('auto layers get the default cap, split when pool-constrained', () => {
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
    // pool = 2500; two auto caps of 2000 each (4000 total headroom) →
    // proportional split of the pool: 1250 each.
    expect(allocations[0].allocated).toBe(1_250);
    expect(allocations[1].allocated).toBe(1_250);
  });

  it('a single auto layer is clamped to the default cap, not the pool', () => {
    const layers = [
      makeLayer('a', 'auto'),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 100_000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    // pool = 25000 but the auto cap bounds the layer at 2000 — the rendered
    // block is the same size whatever the model's context length, which is what
    // makes it cacheable.
    expect(allocations[0].allocated).toBe(AUTO_CAP);
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
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 100,
      systemPromptTokens: 5_000,
      responseReserve: 5_000,
    });
    expect(allocations[0].allocated).toBe(0);
    expect(allocations[1].allocated).toBe(0);
  });

  it('a layer that omits budget gets the auto cap treatment, not 0', () => {
    const layers = [
      makeLayer('no-budget'),
      makeLayer('auto', 'auto'),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 100_000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    expect(allocations[0].allocated).toBe(AUTO_CAP);
    expect(allocations[1].allocated).toBe(AUTO_CAP);
  });

  it('scales minimums down proportionally when they overcommit the pool', () => {
    const layers = [
      makeLayer('a', {
        min: 2_000,
        max: 3_000,
      }),
      makeLayer('b', {
        min: 6_000,
        max: 8_000,
      }),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 10_000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    // pool = 2500, mins total 8000 → scale = 2500/8000
    const sum = allocations.reduce((s, a) => s + a.allocated, 0);
    expect(sum).toBeLessThanOrEqual(2_500);
    // Proportionality preserved (b declared 3x a's min).
    expect(allocations[1].allocated).toBeGreaterThan(allocations[0].allocated * 2.5);
  });

  it('explicit Infinity caps split the remainder after finite caps', () => {
    const layers = [
      makeLayer('finite', {
        min: 0,
        max: 400,
      }),
      makeLayer('uncapped', {
        min: 0,
        max: Number.POSITIVE_INFINITY,
      }),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 10_000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    // pool = 2500; finite gets its full 400 cap; the uncapped layer absorbs
    // the rest. Pool is conserved (floor() may shave a token).
    const sum = allocations.reduce((s, a) => s + a.allocated, 0);
    expect(allocations[0].allocated).toBe(400);
    expect(sum).toBeGreaterThanOrEqual(2_499);
    expect(sum).toBeLessThanOrEqual(2_500);
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
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: Number.POSITIVE_INFINITY,
      systemPromptTokens: 0,
      responseReserve: 4_000,
    });
    for (const a of allocations) {
      expect(Number.isNaN(a.allocated)).toBe(false);
    }
    expect(allocations[0].allocated).toBe(1_000); // capped at max
    expect(allocations[1].allocated).toBe(AUTO_CAP); // capped at the auto default
  });

  it('fractional budgets are accepted (pinned)', () => {
    const layers = [
      makeLayer('auto', 'auto'),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 0.5,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    // pool = 0.125 — sub-token pools floor to 0.
    expect(allocations[0].allocated).toBe(0);
  });

  it('pool share constant is pinned', () => {
    const layers = [
      makeLayer('a', {
        min: 0,
        max: Number.POSITIVE_INFINITY,
      }),
    ];
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: 40_000,
      systemPromptTokens: 0,
      responseReserve: 0,
    });
    // A single uncapped layer absorbs the whole pool: 25% of 40000.
    expect(allocations[0].allocated).toBe(40_000 * POOL_SHARE);
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
