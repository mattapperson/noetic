import type { BudgetConfig, Context, MemoryLayer, ProjectionPolicy } from '@noetic-tools/types';
import { NoeticErrorImpl } from '@noetic-tools/types';

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
  if (config === 'auto') {
    return Number.POSITIVE_INFINITY;
  }
  if (typeof config === 'number') {
    return config;
  }
  if (config && typeof config === 'object' && 'min' in config) {
    return config.max;
  }
  return 0;
}

interface ComputeShareOpts {
  headroom: number;
  layerPool: number;
  infiniteCount: number;
  finiteTotal: number;
  totalMax: number;
  allHeadrooms: number[];
  layerIndex: number;
}

function computeShare({
  headroom,
  layerPool,
  infiniteCount,
  finiteTotal,
  totalMax,
  allHeadrooms,
  layerIndex,
}: ComputeShareOpts): number {
  if (!Number.isFinite(headroom)) {
    // All infinite-headroom layers split the pool after finite layers take their share.
    // `infiniteCount >= 1` is guaranteed here since headroom is infinite.
    const finiteUsed = Number.isFinite(totalMax)
      ? 0
      : allHeadrooms.reduce(
          (sum, m, j) =>
            Number.isFinite(m) && j !== layerIndex
              ? sum + Math.min(m, (m / (finiteTotal || 1)) * layerPool)
              : sum,
          0,
        );
    return (layerPool - finiteUsed) / infiniteCount;
  }

  if (Number.isFinite(totalMax)) {
    return (headroom / totalMax) * layerPool;
  }

  // Mix of finite and infinite: finite layers share half the pool proportionally.
  return finiteTotal > 0 ? (headroom / finiteTotal) * (layerPool * 0.5) : 0;
}

interface AllocateBudgetsOpts {
  layers: MemoryLayer[];
  totalBudget: number;
  systemPromptTokens: number;
  responseReserve: number;
}

export function allocateBudgets({
  layers,
  totalBudget,
  systemPromptTokens,
  responseReserve,
}: AllocateBudgetsOpts): {
  allocations: BudgetAllocation[];
  historyBudget: number;
} {
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
    const finiteTotal = headrooms.reduce((sum, h) => (Number.isFinite(h) ? sum + h : sum), 0);

    for (let i = 0; i < headrooms.length; i++) {
      const share = computeShare({
        headroom: headrooms[i],
        layerPool,
        infiniteCount,
        finiteTotal,
        totalMax,
        allHeadrooms: headrooms,
        layerIndex: i,
      });
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
