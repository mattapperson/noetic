import { frameworkCast } from '@noetic-tools/types';
import { watchLayerPlans } from '../runtime/layer-plans';
import type { LayerStateStore } from './action-deps';
import {
  contextToExecCtx,
  disposeLayers,
  initLayers,
  lineageKey,
  resolveLayerTools,
  unpinLayers,
} from './action-deps';
import { isContextConfig } from './action-tools';
import type {
  Context,
  ContextData,
  ContextLayer,
  ExecuteStepFn,
  StepWithContext,
  StorageAdapter,
  Tool,
} from './action-types';
import { deduplicateTools } from './collect-tools';

function resolveLayers<TContext, I, O>(step: StepWithContext<TContext, I, O>): ContextLayer[] {
  if (isContextConfig(step.context)) {
    return [
      ...step.context.layers,
    ];
  }
  return step.context;
}

function mergeLayers(
  existing: ContextLayer[] | undefined,
  provided: ContextLayer[],
): ContextLayer[] {
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

export interface ExecuteWithContextOpts {
  /** Store holding layer state; without it the provided layers are not initialized or disposed. */
  layerStore?: LayerStateStore;
  /** Backing storage for layer `init`; without it `init` is skipped, as at the harness root. */
  storage?: StorageAdapter;
}

/**
 * Executes a withContext step by attaching context layers to the current
 * context without creating an isolated child context.
 *
 * Unlike spawn, withContext does not create a new itemLog or clone state.
 * Events flow through to the parent in real-time.
 *
 * Layers whose ids the parent does not already have are scoped to the
 * boundary: their `init` runs on entry, and on exit their `dispose` runs,
 * their state is dropped, and their prompt-cache pins are removed so their
 * output does not replay into later model calls. A provided layer that
 * overrides a parent layer of the same id shares that id's state slot, so it
 * is neither initialized nor disposed here.
 */
export async function executeWithContext<TContext, I, O>(
  step: StepWithContext<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  executeStep: ExecuteStepFn,
  opts?: ExecuteWithContextOpts,
): Promise<O> {
  const baseCtx = frameworkCast<
    Context<ContextData> & {
      layers?: ContextLayer[];
      unifiedTools?: ReadonlyArray<Tool>;
    }
  >(ctx);
  const previousLayers = baseCtx.layers;
  const previousUnifiedTools = baseCtx.unifiedTools;
  const newLayers = resolveLayers(step);
  const mergedLayers = mergeLayers(previousLayers, newLayers);
  const parentIds = new Set((previousLayers ?? []).map((l) => l.id));
  const scopedLayers = newLayers.filter((l) => !parentIds.has(l.id));

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

  const layerStore = opts?.layerStore;
  const execCtx = contextToExecCtx(baseCtx);
  try {
    if (layerStore && opts?.storage && scopedLayers.length > 0) {
      watchLayerPlans(baseCtx, scopedLayers);
      await initLayers({
        layers: scopedLayers,
        ctx: execCtx,
        storage: opts.storage,
        store: layerStore,
      });
    }
    return await executeStep<TContext, I, O>(step.child, input, ctx);
  } finally {
    // Restore previous layers and unified tools so siblings are not affected
    baseCtx.layers = previousLayers;
    baseCtx.unifiedTools = previousUnifiedTools;
    if (scopedLayers.length > 0) {
      if (layerStore) {
        await disposeLayers({
          layers: scopedLayers,
          ctx: execCtx,
          store: layerStore,
          scoped: true,
        });
      }
      if (baseCtx.harness.contextCache) {
        unpinLayers(baseCtx.harness.contextCache, lineageKey(execCtx), scopedLayers);
      }
    }
  }
}
