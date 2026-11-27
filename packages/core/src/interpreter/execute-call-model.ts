import type { ContextObservation, OutputCodec, StandardSchemaV1 } from '@noetic-tools/types';
import {
  createMessage,
  estimateTokens,
  extractAssistantText,
  frameworkCast,
  isOutputCodec,
  NoeticConfigError,
  NoeticErrorImpl,
} from '@noetic-tools/types';
import type { EmitOption } from '../runtime/broadcaster-utils';
import { emitOn } from '../runtime/broadcaster-utils';
import { chargeSpent } from '../util/spent';
import {
  commitLayerUsage,
  computeLayerUsage,
  contextToExecCtx,
  createContextCacheStore,
  DEFAULT_PROJECTION,
  emitFrameworkEvent,
  getBroadcaster,
  INTERRUPT_REASON,
  lineageKey,
  noteCacheOutcome,
  resolveCacheConfig,
  shouldEmit,
} from './action-deps';
import {
  MAX_STEERING_RETRIES,
  resolveLazy,
  resolveToolsAndRestrictions,
  splitResolvedTools,
} from './action-tools';
import type {
  CallModelRequest,
  Context,
  ContextData,
  ContextLayer,
  ContextRerenderRequest,
  FunctionCallItem,
  FunctionCallOutputItem,
  InputMessageItem,
  Item,
  LLMResponse,
  ProjectionPolicy,
  ServerToolSpec,
  StepCallModel,
  StepMeta,
  Tool,
} from './action-types';
import { SteeringAction } from './action-types';
import type { BandedView } from './context-assembly';
import {
  anchoringAttributes,
  appendUserInput,
  assembleModelItems,
  computeBudgetMap,
  gatherRecallResults,
  prepareBandedView,
} from './context-assembly';
import { trackUsage } from './message-helpers';
import { wrapModelError } from './model-error';
import { parseStructuredOutput } from './structured-output';
import { isContextImpl, isFunctionCall, isMutableContext } from './typeguards';

//#region Output and turn preparation

/**
 * Classify a step's `output` into the JSON-schema vs streaming-codec modes.
 *
 * An `OutputCodec` (e.g. OpenUI Lang) carries its own system-prompt fragment
 * and is NOT a JSON schema — its `instructions` fold into the system prompt and
 * it is kept off `outputSchema` (which drives JSON-schema formatting).
 */
function resolveOutputMode<O>(
  output: StandardSchemaV1 | OutputCodec<O> | undefined,
  baseInstructions: string | undefined,
): {
  outputCodec: OutputCodec<O> | undefined;
  outputSchema: StandardSchemaV1 | undefined;
  resolvedInstructions: string | undefined;
} {
  // A generic type predicate does not reliably narrow a `StandardSchemaV1 |
  // OutputCodec<O>` union through a free type parameter, so bridge the two
  // branches with the sanctioned framework cast — `isOutputCodec` guarantees
  // the discriminant at runtime.
  const isCodec = isOutputCodec<O>(output);
  const outputCodec = isCodec ? frameworkCast<OutputCodec<O>>(output) : undefined;
  const outputSchema = isCodec ? undefined : frameworkCast<StandardSchemaV1 | undefined>(output);
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
  ctx: Context<ContextData>,
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
    if (shouldEmit(emitOn(emit, ctx), eventType, data)) {
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

/**
 * Turn the finished assistant text into the step's typed output: a streaming
 * codec, a Standard Schema, or raw text passthrough.
 */
async function finalizeStepOutput<O>(params: {
  stepId: string;
  emit: EmitOption | undefined;
  outputCodec: OutputCodec<O> | undefined;
  outputSchema: StandardSchemaV1 | undefined;
  lastText: string;
  ctx: Context<ContextData>;
}): Promise<O> {
  if (params.outputCodec) {
    return finalizeCodecOutput(params.outputCodec, params.lastText, params.ctx, params.emit);
  }
  if (params.outputSchema) {
    return parseStructuredOutput<O>({
      schema: params.outputSchema,
      rawText: params.lastText,
      stepId: params.stepId,
    });
  }
  return frameworkCast<O>(params.lastText);
}

/**
 * Builds the items the model sees for one attempt: system messages stay at the
 * front, the banded anchor/live/delta output rides between them and history,
 * and steering guidance from a prior retry lands at the very tail. The
 * projector enforces the token budget (drops highest-slot layer output, then
 * oldest history).
 */
async function assembleTurnItems(params: {
  ctx: Context<ContextData>;
  layers: ContextLayer[] | undefined;
  banded: BandedView;
  steeringTail: InputMessageItem[];
  viewPolicy: ProjectionPolicy;
}): Promise<ReadonlyArray<Item>> {
  const { ctx, layers, banded, steeringTail, viewPolicy } = params;
  const rawHistoryItems: ReadonlyArray<Item> = ctx.itemLog.items;
  if (layers === undefined || layers.length === 0) {
    return rawHistoryItems;
  }
  const projectedHistoryItems = await ctx.harness.projectHistory(layers, rawHistoryItems, ctx);
  return assembleModelItems({
    history: projectedHistoryItems,
    banded,
    policy: viewPolicy,
    steeringTail,
  });
}

interface BuildModelRequestParams<TContext, I, O> {
  step: StepCallModel<TContext, I, O>;
  ctx: Context<ContextData>;
  layers: ContextLayer[] | undefined;
  resolvedModel: string;
  resolvedInstructions: string | undefined;
  resolvedTools: Tool[] | undefined;
  allowedToolNames: string[] | undefined;
  outputSchema: StandardSchemaV1<unknown, O> | undefined;
  serverToolSpecs: ServerToolSpec[];
  assembledItems: ReadonlyArray<Item>;
  spanAttributes: Record<string, string | number | boolean> | undefined;
}

/**
 * Builds the callModel request for one attempt. Cancellation reaches INSIDE
 * the model call, not just the step boundary: the caller's abort signal stops
 * the stream and the tool-round loop mid flight, so `ctx.abort()` /
 * `harness.cancel()` don't wait out a long generation before taking effect
 * (spec 09, Cancellation item 2).
 */
function buildModelRequest<TContext, I, O>(
  params: BuildModelRequestParams<TContext, I, O>,
): CallModelRequest {
  const { step, ctx, layers } = params;
  const _serverTools = params.serverToolSpecs.length > 0 ? params.serverToolSpecs : undefined;
  const signal = isContextImpl(ctx) ? ctx.abortSignal : undefined;
  // One construction for both shapes: the tool fields vary, but `ctx` (which
  // carries the broadcaster — without it a tool-less call streams NOTHING to
  // getFullStream/getTextStream) and `layers` must be attached either way.
  // The two hand-maintained branches this replaces had drifted exactly there.
  const base = {
    model: params.resolvedModel,
    items: params.assembledItems,
    instructions: params.resolvedInstructions,
    params: step.params,
    toolChoice: step.toolChoice,
    outputSchema: params.outputSchema,
    outputJsonSchema: params.step.outputJsonSchema,
    emit: step.emit,
    _serverTools,
    ctx,
    layers,
    nodeId: step.id,
    parentSpan: ctx.span,
    spanAttributes: params.spanAttributes,
    signal,
  };
  if (params.resolvedTools) {
    return {
      ...base,
      tools: params.resolvedTools,
      allowedToolNames: params.allowedToolNames,
    };
  }
  return base;
}

/**
 * Keep what an interrupted call finished, so the restarted turn knows what
 * already ran. A call cut off mid-round leaves tool calls with no output,
 * which no provider accepts in history, so each gets one.
 */
function keepFinishedItems(ctx: Context<ContextData>, items: ReadonlyArray<Item>): void {
  const answered = new Set(
    items
      .filter((item): item is FunctionCallOutputItem => item.type === 'function_call_output')
      .map((item) => item.callId),
  );
  for (const item of items) {
    ctx.itemLog.append(item);
  }
  for (const call of items.filter(isFunctionCall)) {
    if (answered.has(call.callId)) {
      continue;
    }
    ctx.itemLog.append({
      id: `cancelled-${call.callId}`,
      type: 'function_call_output',
      status: 'incomplete',
      callId: call.callId,
      output: 'Cancelled before it ran.',
    } satisfies FunctionCallOutputItem);
  }
}

/**
 * A guardrail retry throws the response away, but steers in it came from the
 * user, not the model. Log them so the retry still sees them.
 */
function keepSteers(ctx: Context<ContextData>, items: ReadonlyArray<Item>): void {
  for (const item of items) {
    if (item.type === 'message' && item.role !== 'assistant') {
      ctx.itemLog.append(item);
    }
  }
}

/**
 * Records a finished model response on the context: appends response items to
 * the log, publishes `lastStepMeta`, and commits the per-layer usage breakdown
 * (what the model was actually shown, pinned replays included — raw recall
 * output would report content it never saw).
 */
function recordTurnOutcome(params: {
  ctx: Context<ContextData>;
  response: LLMResponse;
  resolvedModel: string;
  resolvedInstructions: string | undefined;
  resolvedTools: Tool[] | undefined;
  banded: BandedView;
}): void {
  const { ctx, response, banded } = params;
  const toolCalls: FunctionCallItem[] = [];
  for (const item of response.items) {
    ctx.itemLog.append(item);
    if (isFunctionCall(item)) {
      toolCalls.push(item);
    }
  }

  const meta: StepMeta = {
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: response.usage,
    cost: response.cost,
    billedCost: response.billedCost,
    serviceTier: response.serviceTier,
    responseItems: response.items,
    // A model call returns only once its response completed: any other status
    // is recovered or thrown before it gets here.
    stopReason: 'end_turn',
    model: params.resolvedModel,
  };

  if (isMutableContext(ctx)) {
    ctx.lastStepMeta = meta;
  }

  commitLayerUsage(
    ctx,
    computeLayerUsage({
      ctx,
      modelId: params.resolvedModel,
      instructions: params.resolvedInstructions,
      tools: params.resolvedTools,
      recallResults: banded.servedPerLayer,
      serveInfo: banded.serveInfo,
      epoch: banded.epoch,
    }),
  );
}

//#endregion

//#region Model step execution

export async function executeCallModel<TContext, I, O>(
  step: StepCallModel<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  layers?: ContextLayer[],
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextData>>(ctx);

  // Resolve lazy step fields up-front. Function-form getters run once per
  // step execution with the live context, so `ctx.harness.config.params`,
  // `ctx.unifiedTools`, and context layer state are all visible at resolution.
  const resolvedModel = (await resolveLazy(step.model, ctx)) ?? baseCtx.harness.config.model;
  if (!resolvedModel || resolvedModel.trim() === '') {
    throw new NoeticConfigError({
      code: 'MISSING_MODEL',
      message: `callModel(${JSON.stringify(step.id)}) has no model.`,
      hint: "Set `model` on the step (a string, or a `(ctx) => string` getter that returns one), or `model` on the harness, e.g. 'anthropic/claude-sonnet-4-20250514'.",
    });
  }
  const baseInstructions = await resolveLazy(step.instructions, ctx);
  const { outputCodec, outputSchema, resolvedInstructions } = resolveOutputMode(
    step.output,
    baseInstructions,
  );
  const listedTools = splitResolvedTools(step, await resolveLazy(step.tools, ctx), baseCtx);
  const serverToolSpecs = listedTools?.serverTools ?? [];

  const rerenderRequests = await appendUserInput({
    ctx: baseCtx,
    layers,
    input,
  });

  const { tools: resolvedTools, allowedToolNames } = resolveToolsAndRestrictions(
    listedTools,
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

  const budgetMap = computeBudgetMap({
    layers,
    policy,
    systemPromptTokens,
  });

  const scope = {
    step,
    ctx: baseCtx,
    layers,
    resolvedModel,
    resolvedInstructions,
    resolvedTools,
    allowedToolNames,
    outputSchema,
    serverToolSpecs,
    viewPolicy,
    budgetMap,
    systemPromptTokens,
  };
  let recallQuery = typeof input === 'string' ? input : '';
  let rerender = rerenderRequests;
  // A steer whose layers asked for recall ends the call early. Recall runs again over
  // the conversation the steer joined, and the call goes on from there.
  for (;;) {
    const observation = baseCtx.harness._observeContext?.(baseCtx, step.id);
    const response = await callOnFreshView(scope, recallQuery, rerender, observation).finally(() =>
      observation?.end(),
    );
    if (!response.recall) {
      return finalizeStepOutput({
        stepId: step.id,
        emit: step.emit,
        outputCodec,
        outputSchema,
        lastText: extractAssistantText(response.items),
        ctx: baseCtx,
      });
    }
    recallQuery = lastInputText(response.items) ?? recallQuery;
    rerender = [];
  }
}

type ViewCallScope<TContext, I, O> = Omit<
  BuildModelRequestParams<TContext, I, O>,
  'assembledItems' | 'spanAttributes'
> & {
  viewPolicy: ProjectionPolicy;
  budgetMap: Map<string, number>;
  systemPromptTokens: number;
};

/**
 * Recall, build the view, and call the model on it, retrying on steering guidance.
 * Returns the response once it is recorded on the context and stored by the layers.
 */
async function callOnFreshView<TContext, I, O>(
  scope: ViewCallScope<TContext, I, O>,
  recallQuery: string,
  rerenderRequests: ContextRerenderRequest[],
  observation?: ContextObservation,
): Promise<LLMResponse> {
  const {
    step,
    ctx: baseCtx,
    layers,
    resolvedModel,
    resolvedInstructions,
    resolvedTools,
    allowedToolNames,
    outputSchema,
    serverToolSpecs,
    viewPolicy,
    budgetMap,
    systemPromptTokens,
  } = scope;
  const hasLayers = layers !== undefined && layers.length > 0;
  const slotOf = new Map(
    (layers ?? []).map((l) => [
      l.id,
      l.slot,
    ]),
  );
  const recallResults = await gatherRecallResults({
    ctx: baseCtx,
    layers,
    recallQuery,
    budgetMap,
    slotOf,
    rerenderRequests,
    observation,
  });

  // Split recall output into the cache-stable anchor band and the live band,
  // replaying pinned anchors and gathering any changes into one supersede
  // message. Runs once, outside the retry loop, for the same reason recall does:
  // a retry replays this view rather than building a new one.
  // A harness that predates anchoring carries no store. Give it a throwaway:
  // nothing survives the turn, so its layers render fresh every time — the
  // behaviour it had before the bands existed.
  const cacheStore = baseCtx.harness.contextCache ?? createContextCacheStore();
  const banded = await prepareBandedView({
    recallResults,
    layers: layers ?? [],
    execCtx: contextToExecCtx(baseCtx),
    store: cacheStore,
    config: baseCtx.harness.config.contextCache,
    instructions: resolvedInstructions,
    policy: viewPolicy,
    systemPromptItems: [],
    budgets: budgetMap,
  });
  // Stamped once per assembly, like the cache judgement below: a steering
  // retry re-sends the same view, so only the first attempt carries them.
  let spanAttributes = anchoringAttributes(banded);

  let retries = 0;
  // Guidance from a steering retry rides at the very end of the view, after the
  // live band and the supersedes, rather than wherever history happens to put it.
  let steeringTail: InputMessageItem[] = [];
  let cacheJudged = false;

  while (retries <= MAX_STEERING_RETRIES) {
    const assembledItems = await assembleTurnItems({
      ctx: baseCtx,
      layers,
      banded,
      steeringTail,
      viewPolicy,
    });

    const request = buildModelRequest({
      step,
      ctx: baseCtx,
      layers,
      resolvedModel,
      resolvedInstructions,
      resolvedTools,
      allowedToolNames,
      outputSchema,
      serverToolSpecs,
      assembledItems,
      spanAttributes,
    });
    if (observation) {
      request._contextObservation = observation;
      request._contextAttempt = retries;
      const origins = new Map<
        Item,
        {
          layerIds: string[];
          placement: 'items' | 'delta';
        }
      >();
      for (const { layerId, items } of banded.servedPerLayer) {
        for (const item of items) {
          const previous = origins.get(item);
          origins.set(item, {
            layerIds: [
              ...new Set([
                ...(previous?.layerIds ?? []),
                layerId,
              ]),
            ],
            placement: 'items',
          });
        }
      }
      for (const item of banded.deltaItems) {
        origins.set(item, {
          layerIds: banded.deltaLayers ?? [],
          placement: 'delta',
        });
      }
      request._contextOrigins = origins;
    }
    spanAttributes = undefined;
    const response = await baseCtx.harness.callModel(request).catch((e: unknown) => {
      chargeSpent(baseCtx, e);
      throw wrapModelError(e, step.id, baseCtx);
    });

    // Track tokens/cost for EVERY model call, including responses steering
    // subsequently rejects (Deny throw / Guide retry below) — the spend is
    // real, and until.maxCost / HarnessResponse.usage must see it (spec 07:
    // tokens accumulate across all LLM calls).
    trackUsage(baseCtx, response);

    // Ask the model's own token report whether the prompt prefix survived. A
    // clear miss records a re-anchor that the next assembly picks up — pins are
    // never touched here, so a response steering later rejects cannot leave the
    // epoch half-rebuilt.
    // Judged once per assembly, not once per call: a steering retry re-sends
    // the same view, so counting its response again would reach the give-up
    // threshold inside a single turn and blind the lineage for good.
    if (banded.epoch && !cacheJudged) {
      cacheJudged = true;
      noteCacheOutcome({
        store: cacheStore,
        key: lineageKey(contextToExecCtx(baseCtx)),
        response,
        config: resolveCacheConfig(baseCtx.harness.config.contextCache),
        expectedTokens: systemPromptTokens + banded.epoch.anchorTokens,
      });
    }

    // An abort that landed mid-call returns whatever rounds completed before
    // the signal fired. The spend is charged above, but a truncated generation
    // is not this step's output — surface cancellation instead.
    if (baseCtx.aborted) {
      if (baseCtx.abortReason === INTERRUPT_REASON) {
        keepFinishedItems(baseCtx, response.items);
      }
      throw new NoeticErrorImpl({
        kind: 'cancelled',
        reason: baseCtx.abortReason ?? 'context aborted',
      });
    }

    if (hasLayers) {
      const decision = await baseCtx.harness.afterModelCall(layers, response, baseCtx);

      if (decision.action === SteeringAction.Deny) {
        throw new NoeticErrorImpl({
          kind: 'steering_denied',
          guidance: decision.guidance,
        });
      }

      if (decision.action === SteeringAction.Guide && retries < MAX_STEERING_RETRIES) {
        const guidance = createMessage(
          decision.guidance ?? 'Please adjust your response.',
          'developer',
        );
        // Logged so it persists into the conversation, and carried as the tail
        // so the retry's view ends on the correction rather than burying it
        // ahead of the live band. Assembly drops it from history to avoid
        // showing it twice.
        keepSteers(baseCtx, response.items);
        baseCtx.itemLog.append(guidance);
        steeringTail = [
          ...steeringTail,
          guidance,
        ];
        retries++;
        continue;
      }
    }

    recordTurnOutcome({
      ctx: baseCtx,
      response,
      resolvedModel,
      resolvedInstructions,
      resolvedTools,
      banded,
    });

    if (hasLayers) {
      await baseCtx.harness.storeLayers(layers, response, baseCtx);
    }

    return response;
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

/** The text of the last input message — the steer that asked for recall. */
function lastInputText(items: ReadonlyArray<Item>): string | undefined {
  for (const item of [
    ...items,
  ].reverse()) {
    if (item.type !== 'message' || item.role === 'assistant') {
      continue;
    }
    const text = item.content
      .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
      .join('\n')
      .trim();
    if (text.length > 0) {
      return text;
    }
  }
  return undefined;
}

//#endregion
