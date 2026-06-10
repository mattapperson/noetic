/**
 * Action step handlers: run, llm, spawn, provide, tool.
 */

import {
  createMessage,
  estimateTokens,
  extractAssistantText,
  frameworkCast,
  isNoeticError,
  NoeticConfigError,
  NoeticErrorImpl,
} from '@noetic-tools/types';
import { ZodError } from 'zod';
import type { ItemSchemaRegistry, LayerStateStore } from './action-deps';
import {
  allocateBudgets,
  assembleView,
  buildToolExecutionContext,
  ContextImpl,
  commitLayerUsage,
  computeLayerUsage,
  contextToExecCtx,
  DEFAULT_PROJECTION,
  defaultItemSchemaRegistry,
  emitFrameworkEvent,
  getBroadcaster,
  resolveLayerTools,
  returnLayers,
  snapshotCwdState,
  spawnLayers,
} from './action-deps';
import type {
  AgentHarnessContract,
  Context,
  ContextMemory,
  ContextRerenderRequest,
  ExecuteStepFn,
  ExecutionContext,
  FunctionCallItem,
  Item,
  MemoryConfig,
  MemoryLayer,
  ProjectionPolicy,
  RecallLayerOutput,
  RetryPolicy,
  StepLLM,
  StepMeta,
  StepProvide,
  StepRun,
  StepSpawn,
  StepTool,
  Tool,
} from './action-types';
import { SteeringAction } from './action-types';
import { cloneWithGuard } from './clone-guard';
import { collectAllTools, deduplicateTools } from './collect-tools';
import { trackUsage } from './message-helpers';
import { getContextChannelStore, isFunctionCall, isMutableContext } from './typeguards';

//#region run

export async function executeRun<TMemory, I, O>(
  step: StepRun<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
): Promise<O> {
  const retry = step.retry;
  const maxAttempts = retry?.maxAttempts ?? 1;

  let lastError = new Error('No attempts executed');

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Cancellation is not a retriable error (spec 09) — an abort that
    // arrived between attempts must stop the loop before re-executing.
    if (ctx.aborted) {
      throw new NoeticErrorImpl({
        kind: 'cancelled',
        reason: ctx.abortReason ?? 'context aborted',
      });
    }
    try {
      return await step.execute(input, ctx);
    } catch (e) {
      // Rethrow cancellation immediately — retrying it would re-run side
      // effects after abort and bury the 'cancelled' kind under step_failed.
      if (isNoeticError(e) && e.noeticError.kind === 'cancelled') {
        throw e;
      }
      lastError = e instanceof Error ? e : new Error(String(e));

      if (attempt < maxAttempts - 1 && retry) {
        const delay = computeDelay(retry, attempt);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw new NoeticErrorImpl({
    kind: 'step_failed',
    stepId: step.id,
    cause: lastError,
    retriesExhausted: maxAttempts > 1,
  });
}

function computeDelay(retry: RetryPolicy, attempt: number): number {
  let delay: number;
  switch (retry.backoff) {
    case 'fixed':
      delay = retry.initialDelay;
      break;
    case 'linear':
      delay = retry.initialDelay * (attempt + 1);
      break;
    case 'exponential':
      delay = retry.initialDelay * 2 ** attempt;
      break;
  }
  return Math.min(delay, retry.maxDelay ?? 30_000);
}

//#endregion

//#region llm

const MAX_STEERING_RETRIES = 3;
const emptyRecall: ReadonlyArray<RecallLayerOutput> = [];

/**
 * Merge re-render recall outputs over the base recall results, replacing entries
 * for the same layer and keeping slot order. New layer entries are appended.
 */
function mergeRecallResults(
  base: RecallLayerOutput[],
  overrides: RecallLayerOutput[],
  slotOf: Map<string, number>,
): RecallLayerOutput[] {
  if (overrides.length === 0) {
    return base;
  }
  const byId = new Map(
    overrides.map((r) => [
      r.layerId,
      r,
    ]),
  );
  const merged = base.map((r) => byId.get(r.layerId) ?? r);
  const seen = new Set(base.map((r) => r.layerId));
  for (const o of overrides) {
    if (!seen.has(o.layerId)) {
      merged.push(o);
    }
  }
  return merged.sort((a, b) => (slotOf.get(a.layerId) ?? 0) - (slotOf.get(b.layerId) ?? 0));
}

interface ResolvedTools {
  tools: Tool[] | undefined;
  allowedToolNames: string[] | undefined;
}

/**
 * Resolves a `Lazy<T>` step field. If the value is a function, it is invoked
 * with the current context; otherwise the value is returned as-is. Supports
 * both sync and async getters.
 *
 * Lazy fields let a step inspect `ctx.harness.config.params`, `ctx.unifiedTools`,
 * or memory layer state to produce per-execution values (model, instructions,
 * tools) without baking them in at build time.
 */
async function resolveLazy<T, TMemory>(
  value: T | ((ctx: Context<TMemory>) => T | Promise<T>),
  ctx: Context<TMemory>,
): Promise<T> {
  if (typeof value !== 'function') {
    return value;
  }
  // The `function` narrowing collapses to `T & Function` when `T` itself can
  // be a function, so we defer to `frameworkCast` — the single sanctioned
  // unsafe coercion helper. Runtime check above guarantees safety.
  const getter = frameworkCast<(ctx: Context<TMemory>) => T | Promise<T>>(value);
  return await getter(ctx);
}

/**
 * Resolves which tools to send and what restrictions to apply.
 *
 * When a unified tool set exists on the context (collected before execution),
 * every LLM call sends the full set and step.tools narrows via allowedToolNames.
 *
 * Semantics:
 *   step.tools = undefined → unrestricted (all tools, no allowedToolNames)
 *   step.tools = []        → no tools at all
 *   step.tools = [a, b]    → full set sent, restrict to a and b
 *
 * Fallback: when no unified set exists (e.g. harness.run() called directly),
 * merge step tools with layer tools as before.
 */
function resolveToolsAndRestrictions(
  stepTools: Tool[] | undefined,
  layers: MemoryLayer[] | undefined,
  ctx: Context,
): ResolvedTools {
  // stepTools = [] → explicit opt-out
  if (stepTools && stepTools.length === 0) {
    return {
      tools: undefined,
      allowedToolNames: undefined,
    };
  }

  const unified = ctx.unifiedTools;
  if (unified && unified.length > 0) {
    const allowedToolNames = stepTools ? stepTools.map((t) => t.name) : undefined;
    return {
      tools: [
        ...unified,
      ],
      allowedToolNames,
    };
  }

  // Fallback: no unified set (direct harness.run() path)
  const layerTools = layers && layers.length > 0 ? resolveLayerTools(layers, ctx.harness, ctx) : [];
  if (layerTools.length === 0 && !stepTools) {
    return {
      tools: undefined,
      allowedToolNames: undefined,
    };
  }
  const merged = [
    ...(stepTools ?? []),
    ...layerTools,
  ];
  return {
    tools: merged.length > 0 ? merged : undefined,
    allowedToolNames: undefined,
  };
}

interface RunInputPipelineParams {
  ctx: Context<ContextMemory>;
  layers: MemoryLayer[];
  input: string;
}

async function runInputPipeline({
  ctx,
  layers,
  input,
}: RunInputPipelineParams): Promise<ContextRerenderRequest[]> {
  const userItem = createMessage(input, 'user');
  const { items: finalItems, rerenderRequests } = await ctx.harness.runAppendPipeline(
    layers,
    [
      userItem,
    ],
    ctx,
  );
  for (const item of finalItems) {
    ctx.itemLog.append(item);
  }
  return rerenderRequests;
}

export async function executeLLM<TMemory, I, O>(
  step: StepLLM<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  layers?: MemoryLayer[],
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextMemory>>(ctx);
  const hasLayers = layers !== undefined && layers.length > 0;

  // Resolve lazy step fields up-front. Function-form getters run once per
  // step execution with the live context, so `ctx.harness.config.params`,
  // `ctx.unifiedTools`, and memory layer state are all visible at resolution.
  const resolvedModel = await resolveLazy(step.model, ctx);
  if (!resolvedModel || resolvedModel.trim() === '') {
    throw new NoeticConfigError({
      code: 'MISSING_MODEL',
      message: `step.llm(${JSON.stringify(step.id)}) resolved model to an empty string.`,
      hint: "Ensure `model` (or your `(ctx) => string` getter) returns a non-empty identifier, e.g. 'anthropic/claude-sonnet-4-20250514'.",
    });
  }
  const resolvedInstructions = await resolveLazy(step.instructions, ctx);
  const resolvedStepTools = await resolveLazy(step.tools, ctx);

  // Append user input — through layer pipeline if layers exist, otherwise direct.
  // The append pipeline may request a context re-render (e.g. a layer that
  // expanded an input reference into new content); applied after recall below.
  let rerenderRequests: ContextRerenderRequest[] = [];
  if (typeof input === 'string' && input.length > 0) {
    if (hasLayers) {
      rerenderRequests = await runInputPipeline({
        ctx: baseCtx,
        layers,
        input,
      });
    } else {
      baseCtx.itemLog.append(createMessage(input, 'user'));
    }
  }

  const { tools: resolvedTools, allowedToolNames } = resolveToolsAndRestrictions(
    resolvedStepTools,
    layers,
    baseCtx,
  );

  // Resolve the projection policy (step override > harness default > fallback)
  // and split the context budget across layers via allocateBudgets.
  const policy: ProjectionPolicy =
    step.projection ?? baseCtx.harness.config.projection ?? DEFAULT_PROJECTION;
  // `instructions` are sent to the model as a separate field, outside the
  // assembled view. Reserve their tokens from the projection budget so the
  // view + instructions together stay within the policy's token budget.
  const systemPromptTokens = resolvedInstructions ? estimateTokens(resolvedInstructions) : 0;
  const viewPolicy: ProjectionPolicy = {
    ...policy,
    tokenBudget: Math.max(0, policy.tokenBudget - systemPromptTokens),
  };

  let budgetMap = new Map<string, number>();
  if (hasLayers) {
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: policy.tokenBudget,
      systemPromptTokens,
      responseReserve: policy.responseReserve,
    });
    budgetMap = new Map(
      allocations.map((a) => [
        a.layerId,
        a.allocated,
      ]),
    );
  }

  // Recall once per LLM step: atomic layers run in the hot path; eventual layers
  // are served from cache. Results drive both the assembled context window and
  // the per-layer usage breakdown (ctx.lastLayerUsage). Recall fires before the
  // steering retry loop because retries replay the same context.
  const recallQuery = typeof input === 'string' ? input : '';
  const slotOf = new Map(
    (layers ?? []).map((l) => [
      l.id,
      l.slot,
    ]),
  );
  let recallResults: ReadonlyArray<RecallLayerOutput> = emptyRecall;
  if (hasLayers) {
    const atomic = await baseCtx.harness.recallLayersAtomic(
      layers,
      recallQuery,
      baseCtx,
      budgetMap,
    );
    const eventual = await baseCtx.harness.recallLayersEventual(
      layers,
      recallQuery,
      baseCtx,
      budgetMap,
    );
    recallResults = [
      ...atomic,
      ...eventual,
    ].sort((a, b) => (slotOf.get(a.layerId) ?? 0) - (slotOf.get(b.layerId) ?? 0));

    // Apply re-render requests collected from the input-append pipeline.
    if (rerenderRequests.length > 0) {
      const rerendered = await baseCtx.harness.executeRerender(
        rerenderRequests,
        layers,
        baseCtx,
        budgetMap,
        recallQuery,
      );
      recallResults = mergeRecallResults(
        [
          ...recallResults,
        ],
        rerendered,
        slotOf,
      );
    }
  }
  const layerOutputItems: Item[] = recallResults.flatMap((r) => r.items);

  let retries = 0;

  while (retries <= MAX_STEERING_RETRIES) {
    const rawHistoryItems: ReadonlyArray<Item> = baseCtx.itemLog.items;
    const projectedHistoryItems = hasLayers
      ? await baseCtx.harness.projectHistory(layers, rawHistoryItems, baseCtx)
      : rawHistoryItems;
    let assembledItems: ReadonlyArray<Item>;
    if (hasLayers) {
      // Keep system messages at the front; the projector enforces the token
      // budget (drops highest-slot layer output, then oldest history).
      const systemItems: Item[] = [];
      const nonSystemHistory: Item[] = [];
      for (const item of projectedHistoryItems) {
        if (item.type === 'message' && item.role === 'system') {
          systemItems.push(item);
          continue;
        }
        nonSystemHistory.push(item);
      }
      assembledItems = assembleView({
        systemPromptItems: systemItems,
        layerOutputItems,
        historyItems: nonSystemHistory,
        policy: viewPolicy,
      });
    } else {
      assembledItems =
        projectedHistoryItems === rawHistoryItems
          ? rawHistoryItems
          : [
              ...projectedHistoryItems,
            ];
    }

    const request = resolvedTools
      ? {
          model: resolvedModel,
          items: assembledItems,
          instructions: resolvedInstructions,
          tools: resolvedTools,
          params: step.params,
          outputSchema: step.output,
          emit: step.emit,
          ctx: baseCtx,
          layers,
          allowedToolNames,
        }
      : {
          model: resolvedModel,
          items: assembledItems,
          instructions: resolvedInstructions,
          params: step.params,
          outputSchema: step.output,
          emit: step.emit,
        };
    const response = await baseCtx.harness.callModel(request);

    // Track tokens/cost for EVERY model call, including responses steering
    // subsequently rejects (Deny throw / Guide retry below) — the spend is
    // real, and until.maxCost / HarnessResponse.usage must see it (spec 07:
    // tokens accumulate across all LLM calls).
    trackUsage(baseCtx, response);

    if (hasLayers) {
      const decision = await baseCtx.harness.afterModelCall(layers, response, baseCtx);

      if (decision.action === SteeringAction.Deny) {
        throw new NoeticErrorImpl({
          kind: 'steering_denied',
          guidance: decision.guidance,
        });
      }

      if (decision.action === SteeringAction.Guide && retries < MAX_STEERING_RETRIES) {
        baseCtx.itemLog.append(
          createMessage(decision.guidance ?? 'Please adjust your response.', 'developer'),
        );
        retries++;
        continue;
      }
    }

    const toolCalls: FunctionCallItem[] = [];
    for (const item of response.items) {
      baseCtx.itemLog.append(item);
      if (isFunctionCall(item)) {
        toolCalls.push(item);
      }
    }

    const meta: StepMeta = {
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: response.usage,
      cost: response.cost,
      responseItems: response.items,
    };

    if (isMutableContext(baseCtx)) {
      baseCtx.lastStepMeta = meta;
    }

    commitLayerUsage(
      baseCtx,
      computeLayerUsage({
        ctx: baseCtx,
        modelId: resolvedModel,
        instructions: resolvedInstructions,
        tools: resolvedTools,
        recallResults,
      }),
    );

    if (hasLayers) {
      await baseCtx.harness.storeLayers(layers, response, baseCtx);
    }

    const lastText = extractAssistantText(response.items);

    if (step.output) {
      try {
        const parsed = JSON.parse(lastText);
        return step.output.parse(parsed);
      } catch (e) {
        if (e instanceof SyntaxError || e instanceof ZodError) {
          throw new NoeticErrorImpl({
            kind: 'llm_parse_error',
            stepId: step.id,
            raw: lastText,
            schema: step.output,
            zodError:
              e instanceof ZodError
                ? e
                : new ZodError([
                    {
                      code: 'custom',
                      message: `Invalid JSON: ${e.message}`,
                      path: [],
                    },
                  ]),
          });
        }
        throw e;
      }
    }

    return frameworkCast<O>(lastText);
  }

  // Safety net: the loop above always returns or throws within the body.
  // This throw is unreachable but protects against future refactors that
  // might break the loop invariant.
  throw new NoeticErrorImpl({
    kind: 'step_failed',
    stepId: step.id,
    cause: new Error('Steering retries exhausted'),
    retriesExhausted: true,
  });
}

//#endregion

//#region spawn

export interface ExecuteSpawnOpts {
  layerStore?: LayerStateStore;
  parentLayers?: MemoryLayer[];
  itemSchemas?: ItemSchemaRegistry;
}

interface CollectSpawnItemsParams {
  layers: MemoryLayer[];
  parentExecutionCtx: ExecutionContext;
  childExecutionCtx: ExecutionContext;
  layerStore: LayerStateStore;
  itemSchemas?: ItemSchemaRegistry;
}

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

export async function executeSpawn<TMemory, I, O>(
  step: StepSpawn<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  executeStep: ExecuteStepFn,
  opts?: ExecuteSpawnOpts,
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextMemory>>(ctx);
  const layers = resolveLayersForSpawn(step, opts?.parentLayers);
  const childId = crypto.randomUUID();
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

  // Collect items from memory layers via onSpawn hooks
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

  // Build unified tool set for child from its step tree + layers
  const childStepTools = collectAllTools(step.child);
  const childLayerTools =
    layers.length > 0 ? resolveLayerTools(layers, baseCtx.harness, baseCtx) : [];
  const childUnifiedTools = deduplicateTools([
    ...childStepTools,
    ...childLayerTools,
  ]);

  // Create child context — empty by default, layers provide items via onSpawn.
  // `id: childId` keeps the ContextImpl's id in sync with the executionId
  // used by spawnLayers/returnLayers in the layer-state store, so writes via
  // `ctx.memory[layerId]` and spawn-boundary hooks read from the same key.
  const childCtx = new ContextImpl({
    harness: baseCtx.harness,
    parent: baseCtx,
    items: childItems,
    state: cloneWithGuard(baseCtx.state, `Spawn '${step.id}'`),
    threadId: baseCtx.threadId,
    resourceId: baseCtx.resourceId,
    channelStore: getContextChannelStore(baseCtx),
    layers: layers.length > 0 ? layers : undefined,
    unifiedTools: childUnifiedTools.length > 0 ? childUnifiedTools : undefined,
    cwdState: snapshotCwdState(baseCtx),
    id: childId,
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

//#region provide

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

//#region tool

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return Symbol.asyncIterator in value;
}

async function consumeToolGenerator(params: {
  generator: AsyncGenerator<unknown, unknown>;
  stepId: string;
  toolName: string;
  ctx: Context<ContextMemory>;
}): Promise<unknown> {
  const broadcaster = getBroadcaster(params.ctx);
  const agentName = params.ctx.harness.config.name;

  while (true) {
    const next = await params.generator.next();
    if (next.done) {
      return next.value;
    }

    emitFrameworkEvent({
      broadcaster,
      agentName,
      eventType: 'tool_progress',
      data: {
        stepId: params.stepId,
        toolName: params.toolName,
        event: next.value,
      },
    });
  }
}

export async function executeTool<TMemory, I, O>(
  step: StepTool<TMemory, I, O>,
  input: I,
  ctx: Context<TMemory>,
  harness: AgentHarnessContract,
  layers?: MemoryLayer[],
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextMemory>>(ctx);
  const args = step.args ? Object.assign({}, input, step.args) : input;

  const parseResult = step.tool.input.safeParse(args);
  if (!parseResult.success) {
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: new Error(`Tool input validation failed: ${parseResult.error.message}`),
      retriesExhausted: false,
    });
  }

  if (layers && layers.length > 0) {
    const decision = await harness.beforeToolCall(
      layers,
      step.tool.name,
      parseResult.data,
      baseCtx,
    );
    if (decision.action !== SteeringAction.Allow) {
      throw new NoeticErrorImpl({
        kind: 'steering_denied',
        guidance: decision.guidance,
      });
    }
  }

  try {
    const toolCtx = buildToolExecutionContext(baseCtx, harness);
    const result = step.tool.execute(parseResult.data, toolCtx);

    if (isAsyncGenerator(result)) {
      return frameworkCast<O>(
        await consumeToolGenerator({
          generator: result,
          stepId: step.id,
          toolName: step.tool.name,
          ctx: baseCtx,
        }),
      );
    }

    return frameworkCast<O>(await result);
  } catch (e) {
    if (e instanceof NoeticErrorImpl) {
      throw e;
    }
    throw new NoeticErrorImpl({
      kind: 'step_failed',
      stepId: step.id,
      cause: e instanceof Error ? e : new Error(String(e)),
      retriesExhausted: false,
    });
  }
}

//#endregion
