import type {
  BooleanQuestion,
  CallModelRequest,
  ChoiceQuestion,
  DecideAnswer,
  DecideQuestion,
  DecideRequest,
  DecideResponse,
  DecideStatePart,
  InputContentPart,
  LLMResponse,
  ScoreQuestion,
} from '@noetic-tools/types';
import {
  choiceValues,
  createMessage,
  DecideOutputError,
  extractAssistantText,
  frameworkCast,
  SpendKind,
  scoreLevels,
} from '@noetic-tools/types';
import type { OpenRouter } from '@openrouter/sdk';
import { z } from 'zod';
import { isErrorStatus, statusOf } from '../util/status-code';
import type { Spend } from './spend';

//#region Types

/** @internal The slice of the SDK client the decide caller uses. */
export type DecisionsClient = Pick<OpenRouter, 'alpha' | 'models'>;

/** @internal */
export interface DecideCallerDeps {
  client?: DecisionsClient;
  callModel: (request: CallModelRequest) => Promise<LLMResponse>;
  /** Per-harness cache: model id → whether it is a decision model (`undefined` while unknown). */
  nativeModels: Map<string, Promise<boolean | undefined>>;
  /** Records each native call before it is sent. Absent without durable storage. */
  spend?: Spend;
}

type NativeQuestion = Parameters<
  OpenRouter['alpha']['decisions']['create']
>[0]['decisionsRequest']['questions'][string];

type NativeResponse = Awaited<ReturnType<OpenRouter['alpha']['decisions']['create']>>;

type NativeAnswer = NativeResponse['answers'][string];

//#endregion

//#region Public API

/**
 * Answer a decide request. Decision models (those whose OpenRouter output
 * modality is `decisions`) answer natively with their own distributions; any
 * other model answers through a structured-output call that estimates them.
 *
 * @internal
 */
export async function callDecide(
  request: DecideRequest,
  deps: DecideCallerDeps,
): Promise<DecideResponse> {
  if (deps.client && (await isDecisionModel(request.model, deps))) {
    return callNative(request, deps.client, deps.spend);
  }
  return callEstimated(request, deps);
}

//#endregion

//#region Model detection

function isDecisionModel(model: string, deps: DecideCallerDeps): Promise<boolean> {
  const cached = deps.nativeModels.get(model);
  if (cached) {
    return cached.then((native) => native ?? false);
  }
  const lookup = lookupDecisionModel(model, deps.client);
  deps.nativeModels.set(model, lookup);
  // A failed lookup says nothing about the model, so the next call asks again.
  void lookup.then((native) => {
    if (native === undefined) {
      deps.nativeModels.delete(model);
    }
  });
  return lookup.then((native) => native ?? false);
}

/** `undefined` when the lookup itself failed, as opposed to the model not being one. */
async function lookupDecisionModel(
  model: string,
  client: DecisionsClient | undefined,
): Promise<boolean | undefined> {
  const slash = model.indexOf('/');
  if (!client || slash <= 0) {
    return false;
  }
  try {
    const { data } = await client.models.get({
      author: model.slice(0, slash),
      slug: model.slice(slash + 1),
    });
    return data.architecture.outputModalities.includes('decisions');
  } catch (e) {
    // An unknown model is not a decision model: the estimated path surfaces the
    // provider's own error for it. Anything else may pass, so it is not cached.
    return statusOf(e) === 404 ? false : undefined;
  }
}

//#endregion

//#region Native path

async function callNative(
  request: DecideRequest,
  client: DecisionsClient,
  spend: Spend | undefined,
): Promise<DecideResponse> {
  const questions: Record<string, NativeQuestion> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    questions[id] = toNativeQuestion(question);
  }
  const decisionsRequest = {
    model: request.model,
    state: toNativeState(request.instructions, request.state),
    questions,
  };
  const response = await sendNative({
    client,
    decisionsRequest,
    request,
    spend,
  });

  const answers: Record<string, DecideAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = fromNativeAnswer(question, response.answers[id]);
    if (answer) {
      answers[id] = answer;
    }
  }
  return {
    answers,
    source: 'native',
    modelId: response.model,
    usage: {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
    },
    cost: response.usage.cost,
  };
}

/**
 * Send one native call under a dispatch record. The dispatch header lets the client's
 * response hook save the generation id when the headers arrive, so a call cut off
 * before its body finishes can still be priced.
 */
async function sendNative({
  client,
  decisionsRequest,
  request,
  spend,
}: {
  client: DecisionsClient;
  decisionsRequest: Parameters<
    DecisionsClient['alpha']['decisions']['create']
  >[0]['decisionsRequest'];
  request: DecideRequest;
  spend: Spend | undefined;
}): Promise<NativeResponse> {
  const dispatch = await spend?.open({
    ctx: request._billTo,
    kind: SpendKind.Decide,
    model: request.model,
    body: decisionsRequest,
  });
  try {
    const response = await client.alpha.decisions.create(
      {
        decisionsRequest,
      },
      {
        signal: request.signal,
        ...(dispatch
          ? {
              headers: dispatch.headers,
            }
          : {}),
      },
    );
    await dispatch?.settle();
    return response;
  } catch (e) {
    if (isErrorStatus(e)) {
      await dispatch?.settle();
    }
    throw e;
  } finally {
    dispatch?.end();
  }
}

/**
 * The native APIs require `instructions` on every question, while Noetic lets a
 * boolean question carry its meaning in `criteria` alone; and TypeSafe needs
 * both criteria sides or neither.
 */
function toNativeQuestion(question: DecideQuestion): NativeQuestion {
  switch (question.type) {
    case 'boolean':
      return toNativeBoolean(question);
    case 'choice': {
      const criteria: Record<string, string | null> = {};
      for (const value of choiceValues(question.choices)) {
        criteria[value] = describeChoice(question, value) ?? null;
      }
      return {
        type: 'choice',
        instructions: question.instructions ?? 'Pick the option that best fits the state.',
        criteria,
      };
    }
    case 'score':
      return {
        type: 'score',
        instructions: question.instructions ?? 'Place the state on this scale.',
        criteria: scoreLevels(question.levels).map((l) =>
          l.description ? `${l.label}: ${l.description}` : l.label,
        ),
      };
  }
}

function toNativeBoolean(question: BooleanQuestion): NativeQuestion {
  const yes = question.criteria?.true;
  const no = question.criteria?.false;
  if (yes && no) {
    const instructions = question.instructions ?? yes;
    return {
      type: 'noul',
      instructions,
      criteria: {
        true: yes,
        false: no,
      },
    };
  }
  // One side alone cannot be sent as criteria, so it joins the instructions.
  const side = yes ? `Yes means: ${yes}` : no ? `No means: ${no}` : '';
  return {
    type: 'noul',
    instructions: [
      question.instructions,
      side,
    ]
      .filter(Boolean)
      .join(' '),
  };
}

function describeChoice(question: ChoiceQuestion, value: string): string | undefined {
  if (Array.isArray(question.choices)) {
    return undefined;
  }
  return frameworkCast<Record<string, string>>(question.choices)[value];
}

/** Named parts become keys; unnamed text and images run in order under `conversation`. */
function toNativeState(
  instructions: string | undefined,
  parts: ReadonlyArray<DecideStatePart>,
): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  if (instructions) {
    state.instructions = instructions;
  }
  const conversation: unknown[] = [];
  for (const part of parts) {
    if (part.type === 'image') {
      conversation.push({
        type: 'image_url',
        image_url: {
          url: part.imageUrl,
        },
      });
      continue;
    }
    if (part.type === 'json') {
      state[part.name] = part.value;
      continue;
    }
    if (part.name) {
      state[part.name] = part.text;
      continue;
    }
    conversation.push(part.text);
  }
  if (conversation.length > 0) {
    state.conversation = conversation;
  }
  return state;
}

/**
 * Map one provider answer. Only an explicit `refusal` becomes a `Refusal`; a
 * missing or mistyped answer comes back `undefined` so validation raises
 * `model_parse_error` instead of passing a provider fault off as the model
 * declining.
 */
function fromNativeAnswer(
  question: DecideQuestion,
  answer: NativeAnswer | undefined,
): DecideAnswer | undefined {
  if (isRefusal(answer)) {
    return {
      type: 'refusal',
    };
  }
  if (question.type === 'boolean' && answer?.type === 'noul') {
    return booleanAnswer(question, answer.noul);
  }
  if (question.type === 'choice' && answer?.type === 'choice') {
    const probabilities = everyOutcome(
      choiceValues(question.choices),
      answer.probabilities ?? {
        [answer.choice]: 1,
      },
    );
    return {
      type: 'choice',
      value: answer.choice,
      confidence: answer.confidence ?? top(probabilities),
      probabilities,
    };
  }
  if (question.type === 'score' && answer?.type === 'score') {
    const labels = scoreLevels(question.levels).map((l) => l.label);
    const rounded = labels[Math.round(answer.score)] ?? '';
    // Score probabilities arrive keyed by level index ('0', '1', …). Without
    // a distribution, all the weight goes on the level the score rounds to.
    const byIndex = answer.probabilities ?? {
      [String(Math.round(answer.score))]: 1,
    };
    const probabilities = everyOutcome(
      labels,
      Object.fromEntries(
        labels.map((label, i) => [
          label,
          byIndex[String(i)] ?? 0,
        ]),
      ),
    );
    return {
      type: 'score',
      value: answer.score,
      level: answer.probabilities ? (argmax(probabilities) ?? rounded) : rounded,
      confidence: answer.confidence ?? top(probabilities),
      probabilities,
    };
  }
  return undefined;
}

//#endregion

//#region Estimated path

/**
 * Ask a chat model for a probability per outcome, `samples` times, and average.
 * Self-reported probabilities are not calibrated — fit for routing thresholds,
 * not for measurement.
 */
async function callEstimated(
  request: DecideRequest,
  deps: DecideCallerDeps,
): Promise<DecideResponse> {
  const schema = estimateSchema(request.questions);
  const samples = Math.max(1, request.samples ?? 1);
  const settled = await Promise.allSettled(
    Array.from(
      {
        length: samples,
      },
      () =>
        deps.callModel({
          model: request.model,
          instructions: estimateInstructions(request),
          items: [
            stateMessage(request.state),
          ],
          // Averaging only helps when the runs can differ.
          params: {
            temperature: samples > 1 ? 0.7 : 0,
          },
          outputSchema: schema,
          signal: request.signal,
          parentSpan: request.parentSpan,
          _billTo: request._billTo,
        }),
    ),
  );
  const runs = settled.flatMap((r) =>
    r.status === 'fulfilled'
      ? [
          r.value,
        ]
      : [],
  );
  const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (runs.length === 0 && failed) {
    throw failed.reason;
  }

  const usage = {
    inputTokens: sum(runs.map((r) => r.usage.inputTokens)),
    outputTokens: sum(runs.map((r) => r.usage.outputTokens)),
  };
  const cost = runs.some((r) => r.cost !== undefined)
    ? sum(runs.map((r) => r.cost ?? 0))
    : undefined;
  // Samples run hot, so one bad reply should cost only itself; fail only when none parse.
  const results = runs.map((run) => parseEstimate(schema, extractAssistantText(run.items)));
  const parsed = results.filter((r): r is EstimateShape => !(r instanceof DecideOutputError));
  const firstError = results.find((r): r is DecideOutputError => r instanceof DecideOutputError);
  if (parsed.length === 0 && firstError) {
    throw new DecideOutputError({
      raw: firstError.raw,
      schema: firstError.schema,
      zodError: firstError.zodError,
      usage,
      cost,
    });
  }
  const answers: Record<string, DecideAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    answers[id] = averageAnswer(
      question,
      parsed.map((p) => p[id]),
    );
  }
  return {
    answers,
    source: 'estimated',
    modelId: request.model,
    usage,
    cost,
  };
}

type EstimateShape = Record<string, Record<string, number>>;

function parseEstimate(
  schema: z.ZodType<EstimateShape>,
  raw: string,
): EstimateShape | DecideOutputError {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    return new DecideOutputError({
      raw,
      schema,
      zodError: result.error,
    });
  }
  return result.data;
}

function estimateSchema(questions: DecideRequest['questions']): z.ZodType<EstimateShape> {
  const shape: Record<string, z.ZodType<Record<string, number>>> = {};
  for (const [id, question] of Object.entries(questions)) {
    const keys = outcomeKeys(question);
    shape[id] = z.object(
      Object.fromEntries(
        keys.map((k) => [
          k,
          z.number().min(0).max(1),
        ]),
      ),
    );
  }
  return frameworkCast<z.ZodType<EstimateShape>>(z.object(shape));
}

/** Booleans estimate `{ yes }`; choices and scores estimate one probability per outcome. */
function outcomeKeys(question: DecideQuestion): string[] {
  switch (question.type) {
    case 'boolean':
      return [
        'yes',
      ];
    case 'choice':
      return choiceValues(question.choices);
    case 'score':
      return scoreLevels(question.levels).map((l) => l.label);
  }
}

function estimateInstructions(request: DecideRequest): string {
  const lines = [
    'You answer questions about the state you are given. For each question, return a probability for every outcome.',
    'For a yes/no question, return the probability of yes. For other questions, the probabilities should sum to 1.',
  ];
  if (request.instructions) {
    lines.push('', request.instructions);
  }
  lines.push('', 'Questions:');
  for (const [id, question] of Object.entries(request.questions)) {
    lines.push(`- ${id}: ${describeQuestion(question)}`);
  }
  return lines.join('\n');
}

function describeQuestion(question: DecideQuestion): string {
  const ask = question.instructions ?? '';
  switch (question.type) {
    case 'boolean': {
      const yes = question.criteria?.true ? ` Yes means: ${question.criteria.true}.` : '';
      const no = question.criteria?.false ? ` No means: ${question.criteria.false}.` : '';
      return `(yes/no) ${ask}${yes}${no}`.trim();
    }
    case 'choice': {
      const options = choiceValues(question.choices).map((v) => {
        const description = describeChoice(question, v);
        return description ? `${v} (${description})` : v;
      });
      return `(one of: ${options.join('; ')}) ${ask}`.trim();
    }
    case 'score':
      return `(scale, lowest first: ${describeLevels(question)}) ${ask}`.trim();
  }
}

function describeLevels(question: ScoreQuestion): string {
  return scoreLevels(question.levels)
    .map((l) => (l.description ? `${l.label} (${l.description})` : l.label))
    .join('; ');
}

function stateMessage(parts: ReadonlyArray<DecideStatePart>) {
  const content: InputContentPart[] = parts.map((part) => {
    if (part.type === 'image') {
      return {
        type: 'input_image',
        imageUrl: part.imageUrl,
      };
    }
    if (part.type === 'json') {
      return {
        type: 'input_text',
        text: `${part.name}: ${JSON.stringify(part.value)}`,
      };
    }
    return {
      type: 'input_text',
      text: part.name ? `${part.name}: ${part.text}` : part.text,
    };
  });
  return {
    ...createMessage('', 'user'),
    content,
  };
}

function averageAnswer(
  question: DecideQuestion,
  samples: ReadonlyArray<Record<string, number> | undefined>,
): DecideAnswer {
  const present = samples.filter((s): s is Record<string, number> => s !== undefined);
  if (present.length === 0) {
    return {
      type: 'refusal',
    };
  }
  const keys = outcomeKeys(question);
  const mean: Record<string, number> = {};
  for (const key of keys) {
    mean[key] = sum(present.map((s) => s[key] ?? 0)) / present.length;
  }
  if (question.type === 'boolean') {
    return booleanAnswer(question, mean.yes ?? 0);
  }
  const probabilities = normalize(mean);
  const best = argmax(probabilities) ?? keys[0] ?? '';
  if (question.type === 'choice') {
    return {
      type: 'choice',
      value: best,
      confidence: top(probabilities),
      probabilities,
    };
  }
  return {
    type: 'score',
    value: sum(keys.map((k, i) => i * (probabilities[k] ?? 0))),
    level: best,
    confidence: top(probabilities),
    probabilities,
  };
}

//#endregion

//#region Helpers

function booleanAnswer(question: BooleanQuestion, probability: number): DecideAnswer {
  return {
    type: 'boolean',
    value: probability >= (question.threshold ?? 0.5),
    probability,
  };
}

/** The SDK surfaces answer types it does not model as `UNKNOWN`, keeping the payload in `raw`. */
function isRefusal(answer: NativeAnswer | undefined): boolean {
  if (answer?.type !== 'UNKNOWN' || !('raw' in answer)) {
    return false;
  }
  const raw = answer.raw;
  return typeof raw === 'object' && raw !== null && 'type' in raw && raw.type === 'refusal';
}

/** One entry per outcome, so a caller can index any choice or level; missing ones read 0. */
function everyOutcome(
  outcomes: readonly string[],
  given: Readonly<Record<string, number>>,
): Record<string, number> {
  return Object.fromEntries(
    outcomes.map((o) => [
      o,
      Object.hasOwn(given, o) ? (given[o] ?? 0) : 0,
    ]),
  );
}

function normalize(probabilities: Record<string, number>): Record<string, number> {
  const keys = Object.keys(probabilities);
  const total = sum(Object.values(probabilities));
  const out: Record<string, number> = {};
  for (const key of keys) {
    out[key] = total > 0 ? (probabilities[key] ?? 0) / total : 1 / keys.length;
  }
  return out;
}

function argmax(probabilities: Record<string, number>): string | undefined {
  let best: string | undefined;
  let bestP = -1;
  for (const [key, p] of Object.entries(probabilities)) {
    if (p > bestP) {
      best = key;
      bestP = p;
    }
  }
  return best;
}

function top(probabilities: Record<string, number>): number {
  return Math.max(0, ...Object.values(probabilities));
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

//#endregion
