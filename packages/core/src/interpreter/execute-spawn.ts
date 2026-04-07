import { resolveLayerTools } from '../memory/layer-api';
import type { LayerStateStore } from '../memory/layer-lifecycle';
import { returnLayers, spawnLayers } from '../memory/layer-lifecycle';
import { ContextImpl } from '../runtime/context-impl';
import type { Context } from '../types/context';
import type { Item } from '../types/items';
import type { ContextMemory, ExecutionContext, MemoryConfig, MemoryLayer } from '../types/memory';
import type { ExecuteStepFn, StepSpawn } from '../types/step';
import { cloneWithGuard } from './clone-guard';
import { collectAllTools, deduplicateTools } from './collect-tools';
import { frameworkCast } from './framework-cast';

//#region Types

export interface ExecuteSpawnOpts {
  layerStore?: LayerStateStore;
  parentLayers?: MemoryLayer[];
}

interface CollectSpawnItemsParams {
  layers: MemoryLayer[];
  parentExecutionCtx: ExecutionContext;
  childExecutionCtx: ExecutionContext;
  layerStore: LayerStateStore;
}

//#endregion

//#region Constants

/** Naive token estimate shared across all spawn execution contexts. */
const naiveTokenize = (text: string): number => Math.ceil(text.length / 4);

/** No-op trace shared across all spawn execution contexts. */
const noopTrace = {
  setAttribute(): void {},
  addEvent(): void {},
} satisfies ExecutionContext['trace'];

//#endregion

//#region Helper Functions

function isMemoryConfig(value: unknown): value is MemoryConfig {
  return typeof value === 'object' && value !== null && 'layers' in value;
}

function resolveLayersForSpawn<TMemory, I, O>(
  step: StepSpawn<TMemory, I, O>,
  parentLayers?: MemoryLayer[],
): MemoryLayer[] {
  if (!step.memory) {
    return parentLayers ?? [];
  }
  if (isMemoryConfig(step.memory)) {
    return [
      ...step.memory.layers,
    ];
  }
  return step.memory;
}

function buildChildExecutionContext(ctx: Context): ExecutionContext {
  return {
    executionId: crypto.randomUUID(),
    threadId: ctx.threadId,
    resourceId: ctx.resourceId,
    depth: ctx.depth + 1,
    stepNumber: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    cost: 0,
    tokenize: naiveTokenize,
    trace: noopTrace,
  };
}

function buildParentExecutionContext(ctx: Context): ExecutionContext {
  return {
    executionId: ctx.id,
    threadId: ctx.threadId,
    resourceId: ctx.resourceId,
    depth: ctx.depth,
    stepNumber: ctx.stepCount,
    tokenUsage: {
      input: ctx.tokens.input,
      output: ctx.tokens.output,
    },
    cost: ctx.cost,
    tokenize: naiveTokenize,
    trace: noopTrace,
  };
}

async function collectSpawnItems({
  layers,
  parentExecutionCtx,
  childExecutionCtx,
  layerStore,
}: CollectSpawnItemsParams): Promise<Item[]> {
  const spawnResults = await spawnLayers({
    layers,
    parentCtx: parentExecutionCtx,
    childCtx: childExecutionCtx,
    store: layerStore,
  });

  return spawnResults.flatMap((r) => r.items);
}

//#endregion

//#region Public API

export async function executeSpawn<TMemory, I, O>(
  step: StepSpawn<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  executeStep: ExecuteStepFn,
  opts?: ExecuteSpawnOpts,
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextMemory>>(ctx);
  const layers = resolveLayersForSpawn(step, opts?.parentLayers);
  const childExecutionCtx = buildChildExecutionContext(baseCtx);
  const layerStore = opts?.layerStore;
  const hasLayers = layers.length > 0 && layerStore !== undefined;

  // Collect items from memory layers via onSpawn hooks
  let childItems: Item[] = [];
  let parentExecutionCtx: ExecutionContext | undefined;
  if (hasLayers) {
    parentExecutionCtx = buildParentExecutionContext(baseCtx);
    childItems = await collectSpawnItems({
      layers,
      parentExecutionCtx,
      childExecutionCtx,
      layerStore,
    });
  }

  // Build unified tool set for child from its step tree + layers
  const childStepTools = collectAllTools(step.child);
  const childLayerTools =
    layers.length > 0 ? resolveLayerTools(layers, baseCtx.harness, baseCtx) : [];
  const childUnifiedTools = deduplicateTools([
    ...childStepTools,
    ...childLayerTools,
  ]);

  // Create child context — empty by default, layers provide items via onSpawn
  const childCtx = new ContextImpl({
    harness: baseCtx.harness,
    parent: baseCtx,
    items: childItems,
    state: cloneWithGuard(baseCtx.state, `Spawn '${step.id}'`),
    threadId: baseCtx.threadId,
    resourceId: baseCtx.resourceId,
    span: baseCtx.span,
    layers: layers.length > 0 ? layers : undefined,
    unifiedTools: childUnifiedTools.length > 0 ? childUnifiedTools : undefined,
  });

  try {
    // Execute the child step
    const childOutput = await executeStep<TMemory, I, O>(
      step.child,
      input,
      frameworkCast<Context<TMemory>>(childCtx),
    );

    // Pipeline result through layer onReturn hooks
    if (!hasLayers || !parentExecutionCtx) {
      return childOutput;
    }

    const pipelinedResult = await returnLayers({
      layers,
      parentCtx: parentExecutionCtx,
      childCtx: childExecutionCtx,
      childLog: childCtx.itemLog,
      result: childOutput,
      store: layerStore,
    });
    return pipelinedResult;
  } finally {
    // Clean up child execution state to prevent memory leaks — runs on success and error
    if (hasLayers) {
      layerStore.cleanup(childExecutionCtx.executionId);
    }
  }
}

//#endregion
