/**
 * Action step handlers: run, llm, spawn, provide, tool.
 */

import type { OutputCodec } from '@noetic-tools/types';
import {
  createMessage,
  estimateTokens,
  extractAssistantText,
  frameworkCast,
  isNoeticError,
  isOutputCodec,
  NoeticConfigError,
  NoeticErrorImpl,
} from '@noetic-tools/types';
import type { ZodType } from 'zod';
import { ZodError } from 'zod';
import type { EmitOption } from '../runtime/broadcaster-utils';
import { emitToolUi } from '../runtime/tool-ui';
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
  shouldEmit,
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
  ServerToolSpec,
  StepLLM,
  StepMeta,
  StepProvide,
  StepRun,
  StepSpawn,
  StepTool,
  Tool,
} from './action-types';
import { isServerToolSpec, SteeringAction } from './action-types';
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
export async function resolveLazy<T, TMemory>(
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

/**
 * Classify a step's `output` into the JSON-schema vs streaming-codec modes.
 *
 * An `OutputCodec` (e.g. OpenUI Lang) carries its own system-prompt fragment
 * and is NOT a JSON schema — its `instructions` fold into the system prompt and
 * it is kept off `outputSchema` (which drives JSON-schema formatting).
 */
function resolveOutputMode<O>(
  output: ZodType<O> | OutputCodec<O> | undefined,
  baseInstructions: string | undefined,
): {
  outputCodec: OutputCodec<O> | undefined;
  outputSchema: ZodType<O> | undefined;
  resolvedInstructions: string | undefined;
} {
  // A generic type predicate does not reliably narrow a `ZodType<O> |
  // OutputCodec<O>` union through a free type parameter, so bridge the two
  // branches with the sanctioned framework cast — `isOutputCodec` guarantees
  // the discriminant at runtime.
  const isCodec = isOutputCodec<O>(output);
  const outputCodec = isCodec ? frameworkCast<OutputCodec<O>>(output) : undefined;
  const outputSchema = isCodec ? undefined : frameworkCast<ZodType<O> | undefined>(output);
  const codecInstructions = outputCodec?.instructions;
  const resolvedInstructions =
    codecInstructions !== undefined
      ? [
          baseInstructions,
          codecInstructions,
        ]
          .filter((s) => s !== undefined)
          .join('\n\n')
      : baseInstructions;
  return {
    outputCodec,
    outputSchema,
    resolvedInstructions,
  };
}

/**
 * Drive an `OutputCodec` with the finished assistant text: emit its `openui.*`
 * framework events (gated by `step.emit`) and return the codec's typed value.
 * True per-delta streaming lives in the model caller; here the statements are
 * delivered at turn finalization, which the transport still forwards.
 */
function finalizeCodecOutput<O>(
  codec: OutputCodec<O>,
  lastText: string,
  ctx: Context<ContextMemory>,
  emit: EmitOption | undefined,
): O {
  const session = codec.start();
  const broadcaster = getBroadcaster(ctx);
  const agentName = ctx.harness.config.name;
  // A streaming codec emits per completed (newline-terminated) statement, so the
  // final line — usually `root` — would stay buffered and never be emitted.
  // Push a newline-terminated copy so that last statement is flushed as an event
  // too; `finish` still reparses the original text for the returned value.
  const textForEmit = lastText.endsWith('\n') ? lastText : `${lastText}\n`;
  session.push(textForEmit, (eventType, data) => {
    if (shouldEmit(emit, eventType, data)) {
      emitFrameworkEvent({
        broadcaster,
        agentName,
        eventType,
        data,
      });
    }
  });
  return session.finish(lastText);
}

/** JSON-parse + Zod-validate the assistant text, raising `llm_parse_error`. */
function parseSchemaOutput<O>(schema: ZodType<O>, lastText: string, stepId: string): O {
  try {
    return schema.parse(JSON.parse(lastText));
  } catch (e) {
    if (e instanceof SyntaxError || e instanceof ZodError) {
      throw new NoeticErrorImpl({
        kind: 'llm_parse_error',
        stepId,
        raw: lastText,
        schema,
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

/**
 * Turn the finished assistant text into the step's typed output: a streaming
 * codec, a Zod schema, or raw text passthrough.
 */
function finalizeStepOutput<O>(params: {
  stepId: string;
  emit: EmitOption | undefined;
  outputCodec: OutputCodec<O> | undefined;
  outputSchema: ZodType<O> | undefined;
  lastText: string;
  ctx: Context<ContextMemory>;
}): O {
  if (params.outputCodec) {
    return finalizeCodecOutput(params.outputCodec, params.lastText, params.ctx, params.emit);
  }
  if (params.outputSchema) {
    return parseSchemaOutput(params.outputSchema, params.lastText, params.stepId);
  }
  return frameworkCast<O>(params.lastText);
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
  const baseInstructions = await resolveLazy(step.instructions, ctx);
  const { outputCodec, outputSchema, resolvedInstructions } = resolveOutputMode(
    step.output,
    baseInstructions,
  );
  const resolvedStepTools = await resolveLazy(step.tools, ctx);

  // `step.tools` is heterogeneous: client `Tool`s plus inline OpenRouter
  // server-tool specs (web search/fetch). Partition them — client tools flow
  // through the unified-tool / allowedToolNames / steering machinery as before;
  // server-tool specs bypass it entirely and are stamped onto the model request
  // (`_serverTools`) for the model caller to wrap via the SDK's `serverTool()`.
  // `undefined` (unrestricted) is preserved as-is; only a present array is
  // partitioned so the `[] = opt-out` semantics of step.tools stay intact.
  let clientStepTools: Tool[] | undefined;
  const serverToolSpecs: ServerToolSpec[] = [];
  if (resolvedStepTools !== undefined) {
    clientStepTools = [];
    for (const entry of resolvedStepTools) {
      if (isServerToolSpec(entry)) {
        serverToolSpecs.push(entry);
      } else {
        clientStepTools.push(entry);
      }
    }
  }

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
    clientStepTools,
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

    const _serverTools = serverToolSpecs.length > 0 ? serverToolSpecs : undefined;
    const request = resolvedTools
      ? {
          model: resolvedModel,
          items: assembledItems,
          instructions: resolvedInstructions,
          tools: resolvedTools,
          params: step.params,
          outputSchema: outputSchema,
          emit: step.emit,
          _serverTools,
          ctx: baseCtx,
          layers,
          allowedToolNames,
          nodeId: step.id,
          parentSpan: baseCtx.span,
        }
      : {
          model: resolvedModel,
          items: assembledItems,
          instructions: resolvedInstructions,
          params: step.params,
          outputSchema: outputSchema,
          emit: step.emit,
          _serverTools,
          nodeId: step.id,
          parentSpan: baseCtx.span,
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
    return finalizeStepOutput({
      stepId: step.id,
      emit: step.emit,
      outputCodec,
      outputSchema,
      lastText,
      ctx: baseCtx,
    });
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

/** Adds a spawned child's accumulated token/cost usage to its parent. */
function rollUpSpawnUsage(parent: Context<ContextMemory>, child: Context<ContextMemory>): void {
  if (!isMutableContext(parent)) {
    return;
  }
  parent.tokens.input += child.tokens.input;
  parent.tokens.output += child.tokens.output;
  parent.tokens.total += child.tokens.total;
  if (child.tokens.cached !== undefined) {
    parent.tokens.cached = (parent.tokens.cached ?? 0) + child.tokens.cached;
  }
  parent.cost += child.cost;
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

  // Build unified tool set for child from its step tree + layers, plus the
  // parent's unified tools. Sub-agents that read tools dynamically (via
  // `ctx.unifiedTools`) otherwise lose the harness tool pool at the spawn
  // boundary — a child whose `step.llm` resolves `tools` from context would
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

    // Roll the child's token/cost usage up into the parent. A sub-agent's
    // spend is the parent's spend; without this it would be stranded on the
    // child context and invisible to `ctx.tokens` / `ctx.cost` / until.maxCost.
    // Because every spawn boundary rolls up, nested sub-agents propagate to the
    // root recursively.
    rollUpSpawnUsage(baseCtx, childCtx);

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
  tool: Tool;
  ctx: Context<ContextMemory>;
  args: unknown;
}): Promise<unknown> {
  const broadcaster = getBroadcaster(params.ctx);
  const agentName = params.ctx.harness.config.name;
  const events: unknown[] = [];

  while (true) {
    const next = await params.generator.next();
    if (next.done) {
      return next.value;
    }

    events.push(next.value);
    emitFrameworkEvent({
      broadcaster,
      agentName,
      eventType: 'tool_progress',
      data: {
        stepId: params.stepId,
        toolName: params.tool.name,
        event: next.value,
      },
    });
    // A direct `step.tool` has no model call id — the step id keys its region.
    emitToolUi({
      ctx: params.ctx,
      tool: params.tool,
      callId: params.stepId,
      phase: 'progress',
      args: params.args,
      events,
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

  emitToolUi({
    ctx: baseCtx,
    tool: step.tool,
    callId: step.id,
    phase: 'call',
    args: parseResult.data,
  });
  try {
    const toolCtx = buildToolExecutionContext(baseCtx, harness);
    const execResult = step.tool.execute(parseResult.data, toolCtx);

    const result = isAsyncGenerator(execResult)
      ? await consumeToolGenerator({
          generator: execResult,
          stepId: step.id,
          tool: step.tool,
          ctx: baseCtx,
          args: parseResult.data,
        })
      : await execResult;

    emitToolUi({
      ctx: baseCtx,
      tool: step.tool,
      callId: step.id,
      phase: 'result',
      args: parseResult.data,
      output: result,
    });
    return frameworkCast<O>(result);
  } catch (e) {
    emitToolUi({
      ctx: baseCtx,
      tool: step.tool,
      callId: step.id,
      phase: 'error',
      args: parseResult.data,
      error: e,
    });
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
