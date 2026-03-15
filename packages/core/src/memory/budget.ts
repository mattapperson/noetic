import type { MemoryLayer, BudgetConfig } from '../types/memory';

export interface BudgetAllocation {
  layerId: string;
  allocated: number;
}

export function allocateBudgets(
  layers: MemoryLayer[],
  totalBudget: number,
  systemPromptTokens: number,
  responseReserve: number,
): { allocations: BudgetAllocation[]; historyBudget: number } {
  const available = totalBudget - responseReserve - systemPromptTokens;
  if (available <= 0) {
    return {
      allocations: layers.map(l => ({ layerId: l.id, allocated: 0 })),
      historyBudget: 0,
    };
  }

  // Phase 1: satisfy minimums
  let remaining = available;
  const allocations: BudgetAllocation[] = [];

  for (const layer of layers) {
    const config = layer.budget;
    let min = 0;
    if (typeof config === 'number') {
      min = 0;
    } else if (config && typeof config === 'object' && 'min' in config) {
      min = config.min;
    }
    allocations.push({ layerId: layer.id, allocated: min });
    remaining -= min;
  }

  // Phase 2: distribute 60% of remaining to layers proportionally, 40% to history
  const layerPool = remaining * 0.6;
  const historyBudget = remaining * 0.4;

  // Distribute layerPool proportionally to max headroom
  let totalMax = 0;
  const maxes: number[] = [];
  for (let i = 0; i < layers.length; i++) {
    const config = layers[i].budget;
    let max = 0;
    if (typeof config === 'number') {
      max = config;
    } else if (config && typeof config === 'object' && 'min' in config) {
      max = config.max;
    } else if (config === 'auto') {
      max = Infinity;
    }
    const headroom = Math.max(0, max - allocations[i].allocated);
    maxes.push(headroom);
    totalMax += headroom;
  }

  if (totalMax > 0) {
    // Count infinite headroom layers for equal distribution
    const infiniteCount = maxes.filter(m => !isFinite(m)).length;
    const finiteTotal = maxes.reduce((sum, m) => (isFinite(m) ? sum + m : sum), 0);

    for (let i = 0; i < layers.length; i++) {
      let share: number;
      if (!isFinite(maxes[i])) {
        // Infinite headroom layers split remaining pool equally
        if (infiniteCount > 0) {
          const finiteUsed = isFinite(totalMax)
            ? 0
            : maxes.reduce((sum, m, j) => (isFinite(m) && j !== i ? sum + Math.min(m, (m / (finiteTotal || 1)) * layerPool) : sum), 0);
          share = (layerPool - finiteUsed) / infiniteCount;
        } else {
          share = layerPool / layers.length;
        }
      } else if (isFinite(totalMax)) {
        share = (maxes[i] / totalMax) * layerPool;
      } else {
        // Mix of finite and infinite: finite layers get proportional to their max from half the pool
        share = finiteTotal > 0 ? (maxes[i] / finiteTotal) * (layerPool * 0.5) : 0;
      }
      const extra = Math.min(share, maxes[i]);
      allocations[i].allocated += extra;
    }
  }

  return { allocations, historyBudget: Math.max(0, historyBudget) };
}
