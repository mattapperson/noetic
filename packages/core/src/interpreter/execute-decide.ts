import type {
  DecideAnswer,
  DecideQuestion,
  DecideQuestions,
  DecideResponse,
  DecideStatePart,
} from '@noetic-tools/types';
import {
  choiceValues,
  DecideOutputError,
  frameworkCast,
  hashString,
  isNoeticError,
  NoeticConfigError,
  NoeticErrorImpl,
  scoreLevels,
} from '@noetic-tools/types';
import { z } from 'zod';
import { GenAI, NoeticAttr } from '../observability/genai-attributes';
import { statusOf } from '../util/status-code';
import { allocateBudgets, assembleView, DECISION_PROJECTION } from './action-deps';
import type {
  Context,
  ContextData,
  ContextLayer,
  Item,
  ProjectionPolicy,
  StepDecide,
} from './action-types';
import { resolveLazy } from './execute-action';
import { trackUsage } from './message-helpers';
import { isContextImpl, isMutableContext } from './typeguards';

//#region Public API

/**
 * Run a `decide` step: build state from the input, the context view, and the
 * step's context selector; ask the harness; validate; record. The conversation
 * is read, never written — no item-log appends, no steering, no layer `store()`.
 * Layers hear about the decision through `onDecision`.
 *
 * @internal
 */
export async function executeDecide<TContext, I, O>(
  step: StepDecide<TContext, I, O>,
  input: I,
  ctx: Context<TContext>,
  layers?: ContextLayer[],
): Promise<O> {
  const baseCtx = frameworkCast<Context<ContextData>>(ctx);
  const key = memoKey(step.id, input, baseCtx.itemLog.items.length);
  const seen = key === undefined ? undefined : answered(baseCtx).get(key);
  if (seen) {
    return frameworkCast<O>(seen);
  }

  const model = await resolveModel(step, ctx);
  const instructions = await resolveLazy(step.instructions, ctx);
  const state = [
    ...inputState(input),
    ...(await viewState(step, input, baseCtx, layers ?? [])),
    ...contextState(step.context ? await step.context(ctx) : undefined),
  ];

  const span = baseCtx.harness.createSpan('decide.call', baseCtx.span);
  span.setAttribute(NoeticAttr.NODE_ID, step.id);
  let answers: Record<string, DecideAnswer>;
  let response: DecideResponse;
  try {
    response = await askHarness(step, baseCtx, {
      model,
      instructions,
      state,
      questions: step.questions,
      samples: step.samples,
      signal: isContextImpl(baseCtx) ? baseCtx.abortSignal : undefined,
      parentSpan: span,
    });
    trackUsage(baseCtx, {
      items: [],
      usage: response.usage,
      cost: response.cost,
    });
    answers = validateAnswers(step.id, step.questions, response.answers);
    stampSpan({
      span,
      response,
      answers,
    });
  } catch (e) {
    span.setAttribute('error', true);
    throw e;
  } finally {
    span.end();
    await baseCtx.harness.traceExporter.export([
      span,
    ]);
  }

  if (baseCtx.aborted) {
    throw new NoeticErrorImpl({
      kind: 'cancelled',
      reason: baseCtx.abortReason ?? 'context aborted',
    });
  }
  if (isMutableContext(baseCtx)) {
    // Merged, not replaced: a loop's `until.noToolCalls()` still reads the tool
    // calls of the llm step that ran before this decision.
    baseCtx.lastStepMeta = {
      ...baseCtx.lastStepMeta,
      usage: response.usage,
      cost: response.cost,
      decision: {
        modelId: response.modelId,
        source: response.source,
        refused: refusedIds(answers),
      },
    };
  }
  if (key !== undefined) {
    answered(baseCtx).set(key, answers);
  }
  if (layers && layers.length > 0) {
    await baseCtx.harness.notifyDecision(
      layers,
      {
        stepId: step.id,
        at: Date.now(),
        modelId: response.modelId,
        source: response.source,
        answers,
      },
      baseCtx,
    );
  }
  return frameworkCast<O>(answers);
}

//#endregion

//#region Reuse

/**
 * Answers already given in each execution, keyed by step id, input, and how
 * long the conversation was. A decide step asked the same thing twice with
 * nothing said in between — say, by two nested routeSwitches — answers from
 * here, so the model is paid once and the two switches cannot disagree. A loop
 * that asks again after new items land gets a fresh decision.
 */
const ANSWERED = new WeakMap<Context<ContextData>, Map<string, Record<string, DecideAnswer>>>();

function answered(ctx: Context<ContextData>): Map<string, Record<string, DecideAnswer>> {
  let map = ANSWERED.get(ctx);
  if (!map) {
    map = new Map();
    ANSWERED.set(ctx, map);
  }
  return map;
}

/** `undefined` when the input cannot be keyed (it does not survive JSON), so it is never reused. */
function memoKey(stepId: string, input: unknown, logLength: number): string | undefined {
  try {
    return `${stepId}\u0000${logLength}\u0000${hashString(JSON.stringify(input) ?? 'undefined')}`;
  } catch {
    return undefined;
  }
}

function refusedIds(answers: Record<string, DecideAnswer>): string[] {
  return Object.entries(answers)
    .filter(([, a]) => a.type === 'refusal')
    .map(([id]) => id);
}

//#endregion

//#region Model + harness call

async function resolveModel<TContext, I, O>(
  step: StepDecide<TContext, I, O>,
  ctx: Context<TContext>,
): Promise<string> {
  const model = (await resolveLazy(step.model, ctx)) ?? ctx.harness.config.decisionModel;
  if (!model || model.trim() === '') {
    throw new NoeticConfigError({
      code: 'MISSING_MODEL',
      message: `decide(${JSON.stringify(step.id)}) has no model.`,
      hint: "Set `model` on the step, or `decisionModel` on the harness, e.g. 'typesafe/jev-1.14'.",
    });
  }
  return model;
}

/** Provider errors arrive raw; give them the step's id and a Noetic kind. */
async function askHarness<TContext, I, O>(
  step: StepDecide<TContext, I, O>,
  ctx: Context<ContextData>,
  request: Parameters<Context['harness']['decide']>[0],
): Promise<DecideResponse> {
  try {
    return await ctx.harness.decide(request);
  } catch (e) {
    if (isNoeticError(e) || e instanceof NoeticConfigError) {
      throw e;
    }
    if (ctx.aborted) {
      throw new NoeticErrorImpl({
        kind: 'cancelled',
        reason: ctx.abortReason ?? 'context aborted',
      });
    }
    if (e instanceof DecideOutputError) {
      if (e.usage) {
        trackUsage(ctx, {
          items: [],
          usage: e.usage,
          cost: e.cost,
        });
      }
      throw new NoeticErrorImpl({
        kind: 'model_parse_error',
        stepId: step.id,
        raw: e.raw,
        schema: e.schema,
        zodError: e.zodError,
      });
    }
    if (statusOf(e) === 429) {
      throw new NoeticErrorImpl({
        kind: 'model_rate_limit',
        stepId: step.id,
      });
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

//#region State

function inputState(input: unknown): DecideStatePart[] {
  if (input === undefined || input === null || input === '') {
    return [];
  }
  if (typeof input === 'string') {
    return [
      {
        type: 'text',
        name: 'input',
        text: input,
      },
    ];
  }
  return [
    {
      type: 'json',
      name: 'input',
      value: input,
    },
  ];
}

/** Selector values ride under one `context` entry, so no key can overwrite `input` or the view. */
function contextState(values: Record<string, unknown> | undefined): DecideStatePart[] {
  if (!values || Object.keys(values).length === 0) {
    return [];
  }
  return [
    {
      type: 'json',
      name: 'context',
      value: values,
    },
  ];
}

/**
 * The same recall + history projection `callModel` sees, within the decision's
 * own budget. Recall peeks, so a decision never drains layer state (such as
 * queued steering guidance) meant for the next model call.
 */
async function viewState<TContext, I, O>(
  step: StepDecide<TContext, I, O>,
  input: I,
  ctx: Context<ContextData>,
  layers: ContextLayer[],
): Promise<DecideStatePart[]> {
  if (step.view === 'none') {
    return [];
  }
  const policy: ProjectionPolicy = step.projection ?? DECISION_PROJECTION;
  const recalled = await peekRecall({
    layers,
    query: typeof input === 'string' ? input : '',
    ctx,
    policy,
  });
  const history =
    step.view === 'full' ? await ctx.harness.projectHistory(layers, ctx.itemLog.items, ctx) : [];
  const view = assembleView({
    systemPromptItems: [],
    layerOutputItems: recalled,
    historyItems: history.filter((item) => !(item.type === 'message' && item.role === 'system')),
    policy,
  });
  return view.flatMap(itemState);
}

async function peekRecall({
  layers,
  query,
  ctx,
  policy,
}: {
  layers: ContextLayer[];
  query: string;
  ctx: Context<ContextData>;
  policy: ProjectionPolicy;
}): Promise<Item[]> {
  if (layers.length === 0) {
    return [];
  }
  const { allocations } = allocateBudgets({
    layers,
    totalBudget: policy.tokenBudget,
    systemPromptTokens: 0,
    responseReserve: policy.responseReserve,
  });
  const budgets = new Map(
    allocations.map((a) => [
      a.layerId,
      a.allocated,
    ]),
  );
  const peek = {
    peek: true,
  };
  const results = [
    ...(await ctx.harness.recallLayersAtomic(layers, query, ctx, budgets, peek)),
    ...(await ctx.harness.recallLayersEventual(layers, query, ctx, budgets, peek)),
  ];
  const slotOf = new Map(
    layers.map((l) => [
      l.id,
      l.slot,
    ]),
  );
  return results
    .sort((a, b) => (slotOf.get(a.layerId) ?? 0) - (slotOf.get(b.layerId) ?? 0))
    .flatMap((r) => r.items);
}

/** Render one view item as state: role-tagged text, plus any images it carries. */
function itemState(item: Item): DecideStatePart[] {
  if (item.type === 'function_call') {
    return [
      {
        type: 'text',
        text: `tool call ${item.name}(${item.arguments})`,
      },
    ];
  }
  if (item.type === 'function_call_output') {
    return [
      {
        type: 'text',
        text: `tool result: ${item.output}`,
      },
    ];
  }
  if (item.type !== 'message') {
    return [];
  }
  const parts: DecideStatePart[] = [];
  const texts: string[] = [];
  for (const part of item.content) {
    if (part.type === 'input_image') {
      parts.push({
        type: 'image',
        imageUrl: part.imageUrl,
      });
      continue;
    }
    if ('text' in part && typeof part.text === 'string') {
      texts.push(part.text);
    }
  }
  if (texts.length > 0) {
    parts.unshift({
      type: 'text',
      text: `${item.role}: ${texts.join('')}`,
    });
  }
  return parts;
}

//#endregion

//#region Validation

function validateAnswers(
  stepId: string,
  questions: DecideQuestions,
  answers: Readonly<Record<string, DecideAnswer>>,
): Record<string, DecideAnswer> {
  const schema = answersSchema(questions);
  const result = schema.safeParse(answers);
  if (!result.success) {
    throw new NoeticErrorImpl({
      kind: 'model_parse_error',
      stepId,
      raw: JSON.stringify(answers),
      schema,
      zodError: result.error,
    });
  }
  return result.data;
}

const Probability = z.number().min(0).max(1);
const RefusalSchema = z.object({
  type: z.literal('refusal'),
});

/** Every question answered or refused, every choice and level known, every probability in range. */
function answersSchema(questions: DecideQuestions): z.ZodType<Record<string, DecideAnswer>> {
  const shape: Record<string, z.ZodType<DecideAnswer>> = {};
  for (const [id, question] of Object.entries(questions)) {
    shape[id] = z.union([
      RefusalSchema,
      answerSchema(question),
    ]);
  }
  return frameworkCast<z.ZodType<Record<string, DecideAnswer>>>(z.object(shape));
}

function answerSchema(question: DecideQuestion): z.ZodType<DecideAnswer> {
  switch (question.type) {
    case 'boolean':
      return z.object({
        type: z.literal('boolean'),
        value: z.boolean(),
        probability: Probability,
      });
    case 'choice': {
      const values = choiceValues(question.choices);
      return z.object({
        type: z.literal('choice'),
        value: z.enum(values),
        confidence: Probability,
        probabilities: knownKeys(values),
      });
    }
    case 'score': {
      const labels = scoreLevels(question.levels).map((l) => l.label);
      return z.object({
        type: z.literal('score'),
        value: z
          .number()
          .min(0)
          .max(labels.length - 1),
        level: z.enum(labels),
        confidence: Probability,
        probabilities: knownKeys(labels),
      });
    }
  }
}

/** A probability for every outcome and for nothing else. */
function knownKeys(keys: readonly string[]) {
  return z
    .object(
      Object.fromEntries(
        keys.map((k) => [
          k,
          Probability,
        ]),
      ),
    )
    .strict();
}

//#endregion

//#region Span

function stampSpan({
  span,
  response,
  answers,
}: {
  span: ReturnType<Context['harness']['createSpan']>;
  response: DecideResponse;
  answers: Record<string, DecideAnswer>;
}): void {
  span.setAttribute(GenAI.REQUEST_MODEL, response.modelId);
  span.setAttribute(GenAI.USAGE_INPUT_TOKENS, response.usage.inputTokens);
  span.setAttribute(GenAI.USAGE_OUTPUT_TOKENS, response.usage.outputTokens);
  if (response.cost !== undefined) {
    span.setAttribute(GenAI.COST, response.cost);
  }
  span.setAttribute(NoeticAttr.DECISION_SOURCE, response.source);
  span.setAttribute(NoeticAttr.DECISION_REFUSED, refusedIds(answers).join(','));
  for (const [id, answer] of Object.entries(answers)) {
    const prefix = `${NoeticAttr.DECISION_PREFIX}${id}`;
    if (answer.type === 'refusal') {
      continue;
    }
    span.setAttribute(`${prefix}.value`, answer.value);
    span.setAttribute(
      answer.type === 'boolean' ? `${prefix}.probability` : `${prefix}.confidence`,
      answer.type === 'boolean' ? answer.probability : answer.confidence,
    );
  }
}

//#endregion
