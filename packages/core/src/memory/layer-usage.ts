import type { Tool } from '../types/common';
import type { Context, LastLayerUsage, LayerUsageEntry } from '../types/context';
import type { RecallLayerOutput } from '../types/runtime';
import { estimateTokens } from '../util/message-helpers';

/**
 * Duck-type check for a Context whose `lastLayerUsage` property is writable.
 * Avoids importing `ContextImpl` (which lives in runtime/) from the memory
 * module — preserving the memory → (no interpreter/runtime) boundary.
 */
type MutableLayerUsageContext = Omit<Context, 'lastLayerUsage'> & {
  lastLayerUsage: LastLayerUsage | undefined;
};

function canWriteLayerUsage(ctx: Context): ctx is MutableLayerUsageContext {
  const desc = Object.getOwnPropertyDescriptor(ctx, 'lastLayerUsage');
  if (desc === undefined) {
    return false;
  }
  return desc.writable !== false;
}

//#region Types

interface ComputeLayerUsageParams {
  ctx: Context;
  modelId: string;
  instructions?: string;
  tools?: ReadonlyArray<Tool>;
  /** Per-layer recall output assembled into the context view for this LLM call. */
  recallResults: ReadonlyArray<RecallLayerOutput>;
}

//#endregion

//#region Helpers

function estimateJsonTokens(value: unknown): number {
  try {
    return estimateTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

//#endregion

//#region Public API

export function computeLayerUsage({
  ctx,
  modelId,
  instructions,
  tools,
  recallResults,
}: ComputeLayerUsageParams): LastLayerUsage {
  const layers: LayerUsageEntry[] = recallResults
    .map((r) => ({
      layerId: r.layerId,
      tokenCount: r.tokenCount,
      items: r.items,
    }))
    .sort((a, b) => a.layerId.localeCompare(b.layerId));

  let historyTokens = 0;
  for (const item of ctx.itemLog.items) {
    historyTokens += estimateJsonTokens(item);
  }

  const systemPromptTokens = instructions ? estimateTokens(instructions) : 0;
  const toolsTokens = tools && tools.length > 0 ? estimateJsonTokens(tools) : 0;
  const layerTotal = layers.reduce((sum, l) => sum + l.tokenCount, 0);
  const totalUsedTokens = systemPromptTokens + toolsTokens + historyTokens + layerTotal;

  return {
    executionId: ctx.id,
    modelId,
    layers,
    systemPromptTokens,
    toolsTokens,
    historyTokens,
    totalUsedTokens,
  };
}

/** Commit computed usage to the Context, replacing any prior snapshot. */
export function commitLayerUsage(ctx: Context, usage: LastLayerUsage): void {
  if (!canWriteLayerUsage(ctx)) {
    return;
  }
  ctx.lastLayerUsage = usage;
}

//#endregion
