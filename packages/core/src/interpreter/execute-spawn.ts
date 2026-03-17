import type { LayerStateStore } from '../memory/layer-lifecycle';
import { returnLayers, spawnLayers } from '../memory/layer-lifecycle';
import { ContextImpl } from '../runtime/context-impl';
import type { Context } from '../types/context';
import type { Item } from '../types/items';
import type { ExecutionContext, MemoryLayer } from '../types/memory';
import type { ExecuteStepFn, StepSpawn } from '../types/step';
import { cloneWithGuard } from './clone-guard';

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
} as const;

//#endregion

//#region Helper Functions

function resolveLayersForSpawn<I, O>(
  step: StepSpawn<I, O>,
  parentLayers?: MemoryLayer[],
): MemoryLayer[] {
  if (step.memory) {
    return step.memory;
  }
  return parentLayers ?? [];
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

export async function executeSpawn<I, O>(
  step: StepSpawn<I, O>,
  input: I,
  ctx: Context,
  executeStep: ExecuteStepFn,
  opts?: ExecuteSpawnOpts,
): Promise<O> {
  const layers = resolveLayersForSpawn(step, opts?.parentLayers);
  const childExecutionCtx = buildChildExecutionContext(ctx);
  const layerStore = opts?.layerStore;
  const hasLayers = layers.length > 0 && layerStore !== undefined;

  // Collect items from memory layers via onSpawn hooks
  let childItems: Item[] = [];
  let parentExecutionCtx: ExecutionContext | undefined;
  if (hasLayers) {
    parentExecutionCtx = buildParentExecutionContext(ctx);
    childItems = await collectSpawnItems({
      layers,
      parentExecutionCtx,
      childExecutionCtx,
      layerStore,
    });
  }

  // Create child context — empty by default, layers provide items via onSpawn
  const childCtx = new ContextImpl({
    parent: ctx,
    items: childItems,
    state: cloneWithGuard(ctx.state, `Spawn '${step.id}'`),
    threadId: ctx.threadId,
    resourceId: ctx.resourceId,
  });

  try {
    // Execute the child step
    const childOutput = await executeStep<I, O>(step.child, input, childCtx);

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
