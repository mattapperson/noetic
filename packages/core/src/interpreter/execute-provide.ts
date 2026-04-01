import { resolveLayerTools } from '../memory/layer-api';
import type { Tool } from '../types/common';
import type { Context } from '../types/context';
import type { ContextMemory, MemoryConfig, MemoryLayer } from '../types/memory';
import type { ExecuteStepFn, StepProvide } from '../types/step';
import { deduplicateTools } from './collect-tools';
import { frameworkCast } from './framework-cast';

//#region Helper Functions

function isMemoryConfig(value: unknown): value is MemoryConfig {
  return typeof value === 'object' && value !== null && 'layers' in value;
}

function resolveLayers<TMemory, I, O>(step: StepProvide<TMemory, I, O>): MemoryLayer[] {
  if (isMemoryConfig(step.memory)) {
    return [
      ...step.memory.layers,
    ];
  }
  return step.memory;
}

function mergeLayers(existing: MemoryLayer[] | undefined, provided: MemoryLayer[]): MemoryLayer[] {
  if (!existing || existing.length === 0) {
    return provided;
  }

  // Provided layers override existing layers with the same id (like nested React context)
  const providedIds = new Set(provided.map((l) => l.id));
  const kept = existing.filter((l) => !providedIds.has(l.id));
  return [
    ...kept,
    ...provided,
  ];
}

//#endregion

//#region Public API

/**
 * Executes a provide step by attaching memory layers to the current context
 * without creating an isolated child context.
 *
 * Unlike spawn, provide does not create a new itemLog or clone state.
 * Events flow through to the parent in real-time.
 */
export async function executeProvide<TMemory, I, O>(
  step: StepProvide<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  executeStep: ExecuteStepFn,
): Promise<O> {
  const baseCtx = frameworkCast<
    Context<ContextMemory> & {
      layers?: MemoryLayer[];
      unifiedTools?: ReadonlyArray<Tool>;
    }
  >(ctx);
  const previousLayers = baseCtx.layers;
  const previousUnifiedTools = baseCtx.unifiedTools;
  const newLayers = resolveLayers(step);
  const mergedLayers = mergeLayers(previousLayers, newLayers);

  // Attach layers to the current context (no isolation)
  baseCtx.layers = mergedLayers;

  // Merge new layer-provided tools into the unified tool set
  if (baseCtx.unifiedTools && newLayers.length > 0) {
    const layerTools = resolveLayerTools(newLayers, baseCtx.harness, baseCtx);
    if (layerTools.length > 0) {
      baseCtx.unifiedTools = deduplicateTools([
        ...baseCtx.unifiedTools,
        ...layerTools,
      ]);
    }
  }

  try {
    return await executeStep<TMemory, I, O>(step.child, input, ctx);
  } finally {
    // Restore previous layers and unified tools so siblings are not affected
    baseCtx.layers = previousLayers;
    baseCtx.unifiedTools = previousUnifiedTools;
  }
}

//#endregion
