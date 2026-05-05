import { z } from 'zod';
import { trackUsage } from '../interpreter/message-helpers';
import type { Context } from '../types/context';
import type { EmbedFn } from '../types/embed';
import type { ContextMemory, StorageAdapter } from '../types/memory';
import type { Step } from '../types/step';
import { createMessage, extractAssistantText } from '../util/message-helpers';
import { cosineSimilarity } from './cosine-similarity';

//#region Types

export type Condition<I> = (input: I, ctx: Context) => Promise<boolean>;

export interface WhenClause<TMemory = ContextMemory, I = unknown, O = unknown> {
  readonly kind: 'when';
  readonly condition: Condition<I>;
  readonly step: Step<TMemory, I, O>;
}

export interface OtherwiseClause<TMemory = ContextMemory, I = unknown, O = unknown> {
  readonly kind: 'otherwise';
  readonly step: Step<TMemory, I, O>;
}

type Clause<TMemory, I, O> = WhenClause<TMemory, I, O> | OtherwiseClause<TMemory, I, O>;

interface VectorCache {
  memory: readonly number[][] | null;
  storage?: StorageAdapter;
}

//#endregion

//#region Helpers

function serializeInput(input: unknown): string {
  return typeof input === 'string' ? input : JSON.stringify(input);
}

function hashLabel(label: string): string {
  return `embed:${encodeURIComponent(label)}`;
}

async function getLabelVectors(
  embed: EmbedFn,
  labels: readonly string[],
  ref: VectorCache,
): Promise<readonly number[][]> {
  if (ref.storage) {
    const storage = ref.storage;
    const keys = labels.map(hashLabel);
    const fetched = await Promise.all(keys.map((k) => storage.get<number[]>(k)));

    const missingIndices: number[] = [];
    for (let i = 0; i < fetched.length; i++) {
      if (!fetched[i]) {
        missingIndices.push(i);
      }
    }

    let freshEmbeddings: readonly number[][] = [];
    if (missingIndices.length > 0) {
      const missingLabels = missingIndices.map((i) => labels[i]);
      // embed returns readonly number[][], spread each row into a mutable copy
      freshEmbeddings = (await embed(missingLabels)).map((v) => Array.from(v));
      await Promise.all(missingIndices.map((idx, j) => storage.set(keys[idx], freshEmbeddings[j])));
    }

    const results: number[][] = new Array(labels.length);
    let freshIndex = 0;
    for (let i = 0; i < fetched.length; i++) {
      results[i] = fetched[i] ?? freshEmbeddings[freshIndex++];
    }
    return results;
  }

  if (ref.memory) {
    return ref.memory;
  }

  const vectors = await embed(labels);
  ref.memory = vectors;
  return vectors;
}

//#endregion

//#region Clause Builders

/**
 * Creates a conditional clause that routes to the given step when the condition is true.
 *
 * @public
 * @param condition - Async predicate evaluated against the input and context.
 * @param step - Step to execute when the condition matches.
 * @returns A `WhenClause` for use in `semanticRoute`.
 */
export function when<TMemory = ContextMemory, I = unknown, O = unknown>(
  condition: Condition<I>,
  step: Step<TMemory, I, O>,
): WhenClause<TMemory, I, O> {
  return {
    kind: 'when',
    condition,
    step,
  };
}

/**
 * Creates a fallback clause that always matches, used as the last clause in `semanticRoute`.
 *
 * @public
 * @param step - Step to execute when no prior `when` clause matches.
 * @returns An `OtherwiseClause` for use in `semanticRoute`.
 */
export function otherwise<TMemory = ContextMemory, I = unknown, O = unknown>(
  step: Step<TMemory, I, O>,
): OtherwiseClause<TMemory, I, O> {
  return {
    kind: 'otherwise',
    step,
  };
}

//#endregion

//#region Route Builders

function isOtherwise<TMemory, I, O>(
  clause: Clause<TMemory, I, O>,
): clause is OtherwiseClause<TMemory, I, O> {
  return clause.kind === 'otherwise';
}

/**
 * Builds a route function from an ordered list of `when`/`otherwise` clauses.
 * Evaluates clauses sequentially, returning the first matching step or `null`.
 *
 * @public
 * @param clauses - Ordered `WhenClause` and optional trailing `OtherwiseClause`.
 * @returns A route function suitable for `branch({ route })`.
 */
export function semanticRoute<TMemory = ContextMemory, I = unknown, O = unknown>(
  ...clauses: Clause<TMemory, I, O>[]
): (input: I, ctx: Context) => Promise<Step<TMemory, I, O> | null> {
  return async (input: I, ctx: Context): Promise<Step<TMemory, I, O> | null> => {
    for (const clause of clauses) {
      if (isOtherwise(clause)) {
        return clause.step;
      }
      const matched = await clause.condition(input, ctx);
      if (matched) {
        return clause.step;
      }
    }
    return null;
  };
}

//#endregion

//#region semanticSwitch

interface SemanticSwitchSimple<TMemory, I, O> {
  embed: EmbedFn;
  cases: Record<string, Step<TMemory, I, O>>;
  default?: Step<TMemory, I, O>;
  threshold?: number;
  cache?: StorageAdapter;
}

interface SemanticSwitchAdvanced<TMemory, I, O> {
  embed: EmbedFn;
  cases: {
    labels: string | string[];
    step: Step<TMemory, I, O>;
  }[];
  default?: Step<TMemory, I, O>;
  threshold?: number;
  cache?: StorageAdapter;
}

/**
 * Builds a route function that selects the best-matching case via embedding cosine similarity.
 *
 * @public
 * @param opts - Simple form with `Record<string, Step>` cases, or advanced form with multi-label cases.
 * @returns A route function suitable for `branch({ route })`.
 */
export function semanticSwitch<TMemory = ContextMemory, I = unknown, O = unknown>(
  opts: SemanticSwitchSimple<TMemory, I, O>,
): (input: I, ctx: Context) => Promise<Step<TMemory, I, O> | null>;

/** @public */
export function semanticSwitch<TMemory = ContextMemory, I = unknown, O = unknown>(
  opts: SemanticSwitchAdvanced<TMemory, I, O>,
): (input: I, ctx: Context) => Promise<Step<TMemory, I, O> | null>;

export function semanticSwitch<TMemory = ContextMemory, I = unknown, O = unknown>(
  opts: SemanticSwitchSimple<TMemory, I, O> | SemanticSwitchAdvanced<TMemory, I, O>,
): (input: I, ctx: Context) => Promise<Step<TMemory, I, O> | null> {
  const threshold = opts.threshold ?? 0.7;

  // Normalize to advanced form
  const cases: {
    labels: string[];
    step: Step<TMemory, I, O>;
  }[] = Array.isArray(opts.cases)
    ? opts.cases.map((c) => ({
        labels: Array.isArray(c.labels)
          ? c.labels
          : [
              c.labels,
            ],
        step: c.step,
      }))
    : Object.entries(opts.cases).map(([label, step]) => ({
        labels: [
          label,
        ],
        step,
      }));

  const allLabels = cases.flatMap((c) => c.labels);
  const labelToCaseIndex: number[] = cases.flatMap((c, i) => c.labels.map(() => i));

  const vectorCache: VectorCache = {
    memory: null,
    storage: opts.cache,
  };

  return async (input: I, _ctx: Context): Promise<Step<TMemory, I, O> | null> => {
    const text = serializeInput(input);
    const [inputVector] = await opts.embed([
      text,
    ]);

    const labelVectors = await getLabelVectors(opts.embed, allLabels, vectorCache);

    let bestScore = Number.NEGATIVE_INFINITY;
    let bestCaseIndex = -1;

    for (let i = 0; i < allLabels.length; i++) {
      const score = cosineSimilarity(inputVector, labelVectors[i]);
      if (score > bestScore) {
        bestScore = score;
        bestCaseIndex = labelToCaseIndex[i];
      }
    }

    if (bestScore < threshold) {
      return opts.default ?? null;
    }

    return cases[bestCaseIndex].step;
  };
}

//#endregion

//#region embeddingMatch

/**
 * Creates a condition that matches when the input embedding is within a cosine similarity threshold of a label.
 *
 * @public
 * @param embed - Embedding function or advanced options object.
 * @param label - Label string (simple form).
 * @param threshold - Minimum cosine similarity score to match.
 * @returns A `Condition` usable in `when()` clauses.
 */
export function embeddingMatch<I>(embed: EmbedFn, label: string, threshold: number): Condition<I>;

/** @public */
export function embeddingMatch<I>(opts: {
  embed: EmbedFn;
  labels: string[];
  threshold: number;
  match?: 'any' | 'all';
  cache?: StorageAdapter;
}): Condition<I>;

export function embeddingMatch<I>(
  embedOrOpts:
    | EmbedFn
    | {
        embed: EmbedFn;
        labels: string[];
        threshold: number;
        match?: 'any' | 'all';
        cache?: StorageAdapter;
      },
  label?: string,
  threshold?: number,
): Condition<I> {
  // Simple form
  if (typeof embedOrOpts === 'function') {
    const embed = embedOrOpts;
    if (label === undefined || threshold === undefined) {
      throw new Error('embeddingMatch: label and threshold are required in simple form');
    }
    const singleLabel = label;
    const thresh = threshold;
    const vectorCache: VectorCache = {
      memory: null,
    };

    return async (input: I, _ctx: Context): Promise<boolean> => {
      const text = serializeInput(input);

      // On first call, batch input + label into one embed request
      if (!vectorCache.memory) {
        const [inputVector, labelVector] = await embed([
          text,
          singleLabel,
        ]);
        vectorCache.memory = [
          labelVector,
        ];
        return cosineSimilarity(inputVector, labelVector) >= thresh;
      }

      const [inputVector] = await embed([
        text,
      ]);
      return cosineSimilarity(inputVector, vectorCache.memory[0]) >= thresh;
    };
  }

  // Advanced form
  const opts = embedOrOpts;
  const matchMode = opts.match ?? 'any';
  const vectorCache: VectorCache = {
    memory: null,
    storage: opts.cache,
  };

  return async (input: I, _ctx: Context): Promise<boolean> => {
    const text = serializeInput(input);
    const [inputVector] = await opts.embed([
      text,
    ]);

    const labelVectors = await getLabelVectors(opts.embed, opts.labels, vectorCache);

    if (matchMode === 'any') {
      return labelVectors.some((vec) => cosineSimilarity(inputVector, vec) >= opts.threshold);
    }
    return labelVectors.every((vec) => cosineSimilarity(inputVector, vec) >= opts.threshold);
  };
}

//#endregion

//#region Combinators

/**
 * Combines conditions with OR semantics; returns true on the first truthy condition.
 *
 * @public
 * @param conditions - Conditions to evaluate.
 * @returns A `Condition` that short-circuits on the first match.
 */
export function anyCondition<I>(...conditions: Condition<I>[]): Condition<I> {
  return async (input: I, ctx: Context): Promise<boolean> => {
    for (const condition of conditions) {
      if (await condition(input, ctx)) {
        return true;
      }
    }
    return false;
  };
}

/**
 * Combines conditions with AND semantics; returns false on the first falsy condition.
 *
 * @public
 * @param conditions - Conditions to evaluate.
 * @returns A `Condition` that short-circuits on the first non-match.
 */
export function allCondition<I>(...conditions: Condition<I>[]): Condition<I> {
  return async (input: I, ctx: Context): Promise<boolean> => {
    for (const condition of conditions) {
      if (!(await condition(input, ctx))) {
        return false;
      }
    }
    return true;
  };
}

//#endregion

//#region aiCondition

const AiConditionResponseSchema = z.object({
  answer: z.boolean(),
});

/**
 * Creates a condition that uses an LLM to classify the input as true or false.
 *
 * @public
 * @param opts - Configuration with model identifier and classification prompt.
 * @returns A `Condition` that delegates boolean classification to the model.
 */
export function aiCondition<I>(opts: { model: string; prompt: string }): Condition<I> {
  return async (input: I, ctx: Context): Promise<boolean> => {
    const text = serializeInput(input);
    const systemPrompt = `You are a boolean classifier. Given the user's input, answer the following question with JSON: {"answer": true} or {"answer": false}.\n\nQuestion: ${opts.prompt}`;
    const items = [
      createMessage(systemPrompt, 'developer'),
      createMessage(text, 'user'),
    ];

    const response = await ctx.harness.callModel({
      model: opts.model,
      items,
      params: {
        temperature: 0,
      },
    });

    trackUsage(ctx, response);

    const responseText = extractAssistantText(response.items);

    try {
      const parsed = JSON.parse(responseText);
      const validated = AiConditionResponseSchema.parse(parsed);
      return validated.answer;
    } catch {
      return false;
    }
  };
}

//#endregion
