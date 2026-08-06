import type { BudgetConfig, Context, ContextLayer, ProjectionPolicy } from '@noetic-tools/types';
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

/**
 * Share of the post-reserve budget offered to context layers as *discretionary*
 * headroom each turn. Layer recall competes with the conversation for the
 * window, and the conversation has to win by default: a layer set that can
 * claim most of the budget starves history and pushes the assembler into
 * trimming turns. `historyPressure` handles the history side.
 *
 * This share bounds the remainder pool only. Declared `min` values are a floor
 * satisfied out of the full available window before this share applies — see
 * `allocateBudgets`.
 */
const LAYER_POOL_SHARE = 0.25;

/** Default cap for layers that declare `'auto'` (or omit) a budget. */
const AUTO_LAYER_CAP = 2_000;

function extractMin(config: BudgetConfig | undefined): number {
  if (config && typeof config === 'object' && 'min' in config) {
    return config.min;
  }
  return 0;
}

/**
 * A layer's declared cap. `'auto'` and omitted budgets get a fixed default cap
 * instead of infinite headroom: an allocation that scales with the model's
 * context length makes the rendered block a different size on a different
 * model — and a different size turn to turn as layers come and go — which is
 * exactly what a prompt cache cannot tolerate. A layer that needs more than
 * the default declares it.
 */
function extractCap(config: BudgetConfig | undefined): number {
  if (config === 'auto' || config === undefined) {
    return AUTO_LAYER_CAP;
  }
  if (typeof config === 'number') {
    return config;
  }
  return config.max;
}

const BUDGET_INPUT_FIELDS = [
  'totalBudget',
  'systemPromptTokens',
  'responseReserve',
] as const;

/**
 * NaN in any budget input silently poisons every allocation downstream
 * (NaN fails the `available <= 0` guard, then every arithmetic op yields
 * NaN). Reject it loudly at the boundary. `Infinity` stays allowed on layer
 * caps — it is a coherent "uncapped" declaration — and fractional values are
 * fine (allocations floor where it matters).
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
  layers: ContextLayer[];
  totalBudget: number;
  systemPromptTokens: number;
  responseReserve: number;
}

/**
 * Split the layer budget across layers, deterministically:
 *
 * 1. **Minimums are satisfied first**, out of the *full* available window
 *    (`totalBudget − responseReserve − systemPromptTokens`) — not out of the
 *    discretionary pool. A layer that declares `{ min: 10_000, max: 12_000 }`
 *    because 10k is what it takes to render a coherent block gets its 10k on a
 *    32k model. Mins are scaled down proportionally only when the mins alone
 *    overcommit the available window, and in that case nothing else is
 *    distributed.
 * 2. The remainder is distributed proportionally to remaining headroom
 *    (`cap − min`), clamped to each cap. `'auto'`/omitted budgets use a fixed
 *    default cap — no infinite-headroom special cases, so the same layer set
 *    gets the same allocation on a 32k model and a 1M one.
 *
 * Only that *discretionary remainder* is rationed by `LAYER_POOL_SHARE`: the
 * remainder pool is `min(available × LAYER_POOL_SHARE, available − totalMin)`,
 * so opportunistic recall cannot claim most of the window, while a declared
 * floor is never silently cut to a fraction of itself. History does not get a
 * per-turn budget line here: it is append-only between explicit compactions,
 * and what the assembler can actually fit is decided in `assembleView` against
 * the same policy (see `historyPressure` for the compaction signal).
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
    };
  }

  // Phase 1: guarantee minimums out of the FULL available window — a declared
  // floor is a floor, not a share of the discretionary pool. Scale down only
  // when the mins alone overcommit what is actually available.
  const mins = layers.map((l) => extractMin(l.budget));
  const totalMin = mins.reduce((sum, m) => sum + m, 0);
  const minScale = totalMin > available ? available / totalMin : 1;
  const allocations: BudgetAllocation[] = layers.map((l, i) => ({
    layerId: l.id,
    allocated: Math.floor(mins[i] * minScale),
  }));
  if (minScale < 1) {
    return {
      allocations,
    };
  }

  // Phase 2: distribute the discretionary remainder proportionally to headroom,
  // clamped to caps. Only this pool is rationed by LAYER_POOL_SHARE, and it can
  // never exceed what the mins left behind.
  const remainder = Math.min(available * LAYER_POOL_SHARE, available - totalMin);
  const headrooms = layers.map((layer, i) => Math.max(0, extractCap(layer.budget) - mins[i]));
  const finiteTotal = headrooms.reduce((sum, h) => (Number.isFinite(h) ? sum + h : sum), 0);
  const infiniteCount = headrooms.filter((h) => !Number.isFinite(h)).length;
  // Explicit `Infinity` caps split whatever the finite headrooms leave over.
  const finitePool = infiniteCount === 0 ? remainder : remainder * 0.5;
  let finiteUsed = 0;
  for (let i = 0; i < headrooms.length; i++) {
    if (!Number.isFinite(headrooms[i]) || finiteTotal === 0) {
      continue;
    }
    const share = Math.min(headrooms[i], (headrooms[i] / finiteTotal) * finitePool);
    allocations[i].allocated += Math.floor(share);
    finiteUsed += share;
  }
  if (infiniteCount > 0) {
    const perInfinite = (remainder - finiteUsed) / infiniteCount;
    for (let i = 0; i < headrooms.length; i++) {
      if (!Number.isFinite(headrooms[i])) {
        allocations[i].allocated += Math.floor(perInfinite);
      }
    }
  }

  return {
    allocations,
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
