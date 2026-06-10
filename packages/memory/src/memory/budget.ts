import type { BudgetConfig, Context, MemoryLayer, ProjectionPolicy } from '@noetic-tools/types';
import { NoeticConfigError, NoeticErrorImpl } from '@noetic-tools/types';

export interface BudgetAllocation {
  layerId: string;
  allocated: number;
}

/**
 * Fallback projection policy when neither a step nor the harness configures one.
 * The token budget is a conservative default; configure `harness.projection` or
 * `step.projection` to match the target model's real context length.
 */
export const DEFAULT_PROJECTION: ProjectionPolicy = {
  tokenBudget: 128e3,
  responseReserve: 4e3,
  overflow: 'sliding_window',
};

function extractMin(config: BudgetConfig | undefined): number {
  if (config && typeof config === 'object' && 'min' in config) {
    return config.min;
  }
  return 0;
}

function extractMax(config: BudgetConfig | undefined): number {
  // 'auto' AND omitted budgets have infinite headroom (spec 11): a layer that
  // declares no budget splits the proportional pool with the 'auto' layers
  // rather than being starved at 0.
  if (config === 'auto' || config === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  if (typeof config === 'number') {
    return config;
  }
  if (typeof config === 'object' && 'min' in config) {
    return config.max;
  }
  return 0;
}

/**
 * Single-priced finite shares: each finite layer's share is computed ONCE and
 * that same value is subtracted from the pool before infinite-headroom layers
 * split the remainder — so the pool is conserved (Σ shares === layerPool when
 * any infinite layer exists). With no infinite layers, finite layers split the
 * whole pool proportionally; with a mix, finite layers share half the pool,
 * clamped to their headroom.
 */
function computeFiniteShares(headrooms: number[], layerPool: number): number[] {
  const infiniteCount = headrooms.filter((h) => !Number.isFinite(h)).length;
  const finiteTotal = headrooms.reduce((sum, h) => (Number.isFinite(h) ? sum + h : sum), 0);
  const finitePool = infiniteCount === 0 ? layerPool : layerPool * 0.5;
  return headrooms.map((h) => {
    if (!Number.isFinite(h) || finiteTotal === 0) {
      return 0;
    }
    const proportional = (h / finiteTotal) * finitePool;
    return infiniteCount === 0 ? proportional : Math.min(h, proportional);
  });
}

const BUDGET_INPUT_FIELDS = [
  'totalBudget',
  'systemPromptTokens',
  'responseReserve',
] as const;

/**
 * NaN in any budget input silently poisons every allocation downstream
 * (NaN fails the `available <= 0` guard, then every arithmetic op yields
 * NaN). Reject it loudly at the boundary. `Infinity` stays allowed — it is a
 * coherent "uncapped" budget — and fractional values are fine (allocations
 * floor where it matters).
 */
function assertBudgetInputs(opts: AllocateBudgetsOpts): void {
  for (const field of BUDGET_INPUT_FIELDS) {
    if (Number.isNaN(opts[field])) {
      throw new NoeticConfigError({
        code: 'INVALID_BUDGET_INPUT',
        message: `allocateBudgets: ${field} is NaN.`,
        hint: 'Pass a real number (Infinity is allowed for an uncapped budget).',
      });
    }
  }
}

interface AllocateBudgetsOpts {
  layers: MemoryLayer[];
  totalBudget: number;
  systemPromptTokens: number;
  responseReserve: number;
}

/**
 * Split the recall budget across layers: minimums first, then 60% of the
 * remainder as a proportional pool (by headroom `max − min`; `'auto'` and
 * omitted budgets have infinite headroom and split the pool after finite
 * layers take their share), 40% reserved for history. The pool is conserved —
 * finite shares plus the infinite layers' split always sum to the pool.
 *
 * Input contract: `totalBudget` / `systemPromptTokens` / `responseReserve`
 * MUST NOT be NaN (throws `NoeticConfigError` code `INVALID_BUDGET_INPUT`).
 * `Infinity` is allowed (= uncapped) and fractional values are accepted.
 */
export function allocateBudgets({
  layers,
  totalBudget,
  systemPromptTokens,
  responseReserve,
}: AllocateBudgetsOpts): {
  allocations: BudgetAllocation[];
  historyBudget: number;
} {
  assertBudgetInputs({
    layers,
    totalBudget,
    systemPromptTokens,
    responseReserve,
  });
  const available = totalBudget - responseReserve - systemPromptTokens;
  if (available <= 0) {
    return {
      allocations: layers.map((l) => ({
        layerId: l.id,
        allocated: 0,
      })),
      historyBudget: 0,
    };
  }

  // Phase 1: satisfy minimums
  let remaining = available;
  const allocations: BudgetAllocation[] = [];

  for (const layer of layers) {
    const min = extractMin(layer.budget);
    allocations.push({
      layerId: layer.id,
      allocated: min,
    });
    remaining -= min;
  }

  // Declared minimums overcommit the available budget: scale them down
  // proportionally so the total fits `available` (never negative, never over).
  // Nothing is left for the proportional pool or history.
  if (remaining < 0) {
    const totalMin = available - remaining;
    const scale = totalMin > 0 ? available / totalMin : 0;
    for (const alloc of allocations) {
      alloc.allocated = Math.floor(alloc.allocated * scale);
    }
    return {
      allocations,
      historyBudget: 0,
    };
  }

  // Phase 2: distribute 60% of remaining to layers proportionally, 40% to history
  const layerPool = remaining * 0.6;
  const historyBudget = remaining * 0.4;

  // Compute headroom per layer (how much above the minimum each layer can absorb)
  let totalMax = 0;
  const headrooms: number[] = [];
  for (let i = 0; i < layers.length; i++) {
    const max = extractMax(layers[i].budget);
    const headroom = Math.max(0, max - allocations[i].allocated);
    headrooms.push(headroom);
    totalMax += headroom;
  }

  if (totalMax > 0) {
    const infiniteCount = headrooms.filter((h) => !Number.isFinite(h)).length;
    const finiteShares = computeFiniteShares(headrooms, layerPool);
    const finiteUsed = finiteShares.reduce((sum, s) => sum + s, 0);
    // Infinite-headroom layers split exactly what the finite shares left over,
    // so no part of the pool is silently lost.
    const infiniteShare = infiniteCount > 0 ? (layerPool - finiteUsed) / infiniteCount : 0;

    for (let i = 0; i < headrooms.length; i++) {
      const share = Number.isFinite(headrooms[i]) ? finiteShares[i] : infiniteShare;
      allocations[i].allocated += Math.min(share, headrooms[i]);
    }
  }

  return {
    allocations,
    historyBudget: Math.max(0, historyBudget),
  };
}

export interface BudgetLimits {
  maxCost?: number;
  maxSteps?: number;
  maxDuration?: number;
}

export function checkBudget(ctx: Context, limits: BudgetLimits): void {
  if (limits.maxCost !== undefined && ctx.cost > limits.maxCost) {
    throw new NoeticErrorImpl({
      kind: 'budget_exceeded',
      field: 'cost',
      limit: limits.maxCost,
      actual: ctx.cost,
    });
  }
  if (limits.maxSteps !== undefined && ctx.stepCount > limits.maxSteps) {
    throw new NoeticErrorImpl({
      kind: 'budget_exceeded',
      field: 'steps',
      limit: limits.maxSteps,
      actual: ctx.stepCount,
    });
  }
  if (limits.maxDuration !== undefined && ctx.elapsed > limits.maxDuration) {
    throw new NoeticErrorImpl({
      kind: 'budget_exceeded',
      field: 'duration',
      limit: limits.maxDuration,
      actual: ctx.elapsed,
    });
  }
}
