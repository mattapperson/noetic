import { frameworkCast } from '@noetic-tools/types';
import { watchLayerPlans } from '../runtime/layer-plans';
import type { ItemSchemaRegistry, LayerStateStore, SessionCtxExtension } from './action-deps';
import {
  ContextImpl,
  contextToExecCtx,
  defaultItemSchemaRegistry,
  resolveLayerTools,
  returnLayers,
  snapshotCwdState,
  spawnLayers,
} from './action-deps';
import { isContextConfig } from './action-tools';
import type {
  Context,
  ContextData,
  ContextLayer,
  ExecuteStepFn,
  ExecutionContext,
  Item,
  StepSpawn,
} from './action-types';
import { openChildSpan, traceChild } from './child-span';
import { cloneWithGuard } from './clone-guard';
import { collectAllTools, deduplicateTools } from './collect-tools';
import { getContextChannelStore } from './typeguards';

export interface ExecuteSpawnOpts {
  layerStore?: LayerStateStore;
  parentLayers?: ContextLayer[];
  itemSchemas?: ItemSchemaRegistry;
  /** Id for the child context; generated when absent. */
  childId?: string;
}

interface CollectSpawnItemsParams {
  layers: ContextLayer[];
  parentExecutionCtx: ExecutionContext;
  childExecutionCtx: ExecutionContext;
  layerStore: LayerStateStore;
  itemSchemas?: ItemSchemaRegistry;
}

function resolveLayersForSpawn<TContext, I, O>(
  step: StepSpawn<TContext, I, O>,
  parentLayers?: ContextLayer[],
): ContextLayer[] {
  if (!step.context) {
    return parentLayers ?? [];
  }
  if (isContextConfig(step.context)) {
    return [
      ...step.context.layers,
    ];
  }
  return step.context;
}

async function collectSpawnItems({
  layers,
  parentExecutionCtx,
  childExecutionCtx,
  layerStore,
  itemSchemas = defaultItemSchemaRegistry,
}: CollectSpawnItemsParams): Promise<Item[]> {
  const spawnResults = await spawnLayers({
    layers,
    parentCtx: parentExecutionCtx,
    childCtx: childExecutionCtx,
    store: layerStore,
    itemSchemas,
  });

  return spawnResults.flatMap((r) => r.items);
}

export async function executeSpawn<TContext, I, O>(
  step: StepSpawn<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  executeStep: ExecuteStepFn,
  opts?: ExecuteSpawnOpts,
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextData>>(ctx);
  const layers = resolveLayersForSpawn(step, opts?.parentLayers);
  const childId = opts?.childId ?? crypto.randomUUID();
  const childExecutionCtx = contextToExecCtx(baseCtx, {
    executionId: childId,
    depth: baseCtx.depth + 1,
    stepNumber: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    cost: 0,
    readLayerStateId: childId,
  });
  const layerStore = opts?.layerStore;
  const hasLayers = layers.length > 0 && layerStore !== undefined;

  // Collect items from context layers via onSpawn hooks
  let childItems: Item[] = [];
  let parentExecutionCtx: ExecutionContext | undefined;
  if (hasLayers) {
    parentExecutionCtx = contextToExecCtx(baseCtx);
    childItems = await collectSpawnItems({
      layers,
      parentExecutionCtx,
      childExecutionCtx,
      layerStore,
      itemSchemas: opts?.itemSchemas,
    });
  }

  // Build unified tool set for child from its step tree + layers, plus the
  // parent's unified tools. Sub-agents that read tools dynamically (via
  // `ctx.unifiedTools`) otherwise lose the harness tool pool at the spawn
  // boundary — a child whose `callModel` resolves `tools` from context would
  // see nothing. Inheriting the parent's tools keeps the harness toolset
  // available across spawns; the child's own step/layer tools take precedence
  // on name collision (dedup keeps the first occurrence), and children that
  // need a restricted set filter explicitly.
  const childStepTools = collectAllTools(step.child);
  const childLayerTools =
    layers.length > 0 ? resolveLayerTools(layers, baseCtx.harness, baseCtx) : [];
  const childUnifiedTools = deduplicateTools([
    ...childStepTools,
    ...childLayerTools,
    ...(baseCtx.unifiedTools ?? []),
  ]);

  // Create child context — empty by default, layers provide items via onSpawn.
  // `id: childId` keeps the ContextImpl's id in sync with the executionId
  // used by spawnLayers/returnLayers in the layer-state store, so writes via
  // `ctx.context[layerId]` and spawn-boundary hooks read from the same key.
  const span = openChildSpan(baseCtx, 'spawn', step.id);
  const childCtx = new ContextImpl({
    harness: baseCtx.harness,
    parent: baseCtx,
    span,
    items: childItems,
    state: cloneWithGuard(baseCtx.state, `Spawn '${step.id}'`),
    threadId: baseCtx.threadId,
    resourceId: baseCtx.resourceId,
    channelStore: getContextChannelStore(baseCtx),
    layers: layers.length > 0 ? layers : undefined,
    unifiedTools: childUnifiedTools.length > 0 ? childUnifiedTools : undefined,
    cwdState: snapshotCwdState(baseCtx),
    id: childId,
    // The spawn's own path prefixes the child's, so a resumed run lines its steps up
    // with the ones recorded inside the same spawn rather than at the root.
    path: baseCtx instanceof ContextImpl ? baseCtx.branchPath('') : undefined,
    ledger: baseCtx instanceof ContextImpl ? baseCtx.ledger : undefined,
    // The child's steps checkpoint the root, as an inParallel path's do.
    checkpointFn: () => baseCtx.checkpoint(),
  });

  if (step.steers === 'forward') {
    frameworkCast<SessionCtxExtension>(childCtx)._forwardSteers = true;
  }
  // The child's layers report their plans as the child writes them; the plan
  // `onSpawn` already gave it is told now.
  if (hasLayers) {
    watchLayerPlans(childCtx, layers);
  }

  // `childExecutionCtx` predates the spawn span; the child's hooks trace onto that span.
  const childTracedCtx: ExecutionContext = {
    ...childExecutionCtx,
    trace: contextToExecCtx(childCtx).trace,
  };
  if (hasLayers && parentExecutionCtx) {
    layerStore.adopt?.({
      parentExecutionId: parentExecutionCtx.executionId,
      ctx: childTracedCtx,
      layers,
      log: childCtx.itemLog,
      itemSchemas: opts?.itemSchemas,
    });
  }

  try {
    return await traceChild(baseCtx, span, async () => {
      // Execute the child step. Its token/cost usage needs no merge here: every
      // charge recorded on `childCtx` is also charged up its `usageParent`
      // chain as it is spent, so a child that throws still bills the parent.
      const childOutput = await executeStep<TContext, I, O>(
        step.child,
        input,
        frameworkCast<Context<TContext>>(childCtx),
      );

      // Pipeline result through layer onReturn hooks
      if (!hasLayers || !parentExecutionCtx) {
        return childOutput;
      }

      return returnLayers({
        layers,
        stepId: step.id,
        parentCtx: parentExecutionCtx,
        childCtx: childTracedCtx,
        childLog: childCtx.itemLog,
        result: childOutput,
        store: layerStore,
      });
    });
  } finally {
    // Clean up child execution state to prevent memory leaks — runs on success and error
    if (hasLayers) {
      layerStore.cleanup(childExecutionCtx.executionId);
    }
    // The child is settled: leave the parent's abort cascade so a parent that
    // outlives many spawns does not retain every finished child.
    childCtx.detachFromParent();
  }
}
