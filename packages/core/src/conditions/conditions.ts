import { z } from 'zod';
import type { CallModelFn } from '../interpreter/execute-llm';
import { createMessage, extractAssistantText } from '../interpreter/message-helpers';
import type { Context } from '../types/context';
import type { EmbedFn } from '../types/embed';
import type { StorageAdapter } from '../types/memory';
import type { Step } from '../types/step';
import { cosineSimilarity } from './cosine-similarity';

//#region Types

export type Condition<I> = (input: I, ctx: Context) => Promise<boolean>;

export interface WhenClause<I, O> {
  readonly kind: 'when';
  readonly condition: Condition<I>;
  readonly step: Step<I, O>;
}

export interface OtherwiseClause<I, O> {
  readonly kind: 'otherwise';
  readonly step: Step<I, O>;
}

type Clause<I, O> = WhenClause<I, O> | OtherwiseClause<I, O>;

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

export function when<I, O>(condition: Condition<I>, step: Step<I, O>): WhenClause<I, O> {
  return {
    kind: 'when',
    condition,
    step,
  };
}

export function otherwise<I, O>(step: Step<I, O>): OtherwiseClause<I, O> {
  return {
    kind: 'otherwise',
    step,
  };
}

//#endregion

//#region Route Builders

function isOtherwise<I, O>(clause: Clause<I, O>): clause is OtherwiseClause<I, O> {
  return clause.kind === 'otherwise';
}

export function semanticRoute<I, O>(
  ...clauses: Clause<I, O>[]
): (input: I, ctx: Context) => Promise<Step<I, O> | null> {
  return async (input: I, ctx: Context): Promise<Step<I, O> | null> => {
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

interface SemanticSwitchSimple<I, O> {
  embed: EmbedFn;
  cases: Record<string, Step<I, O>>;
  default?: Step<I, O>;
  threshold?: number;
  cache?: StorageAdapter;
}

interface SemanticSwitchAdvanced<I, O> {
  embed: EmbedFn;
  cases: {
    labels: string | string[];
    step: Step<I, O>;
  }[];
  default?: Step<I, O>;
  threshold?: number;
  cache?: StorageAdapter;
}

export function semanticSwitch<I, O>(
  opts: SemanticSwitchSimple<I, O>,
): (input: I, ctx: Context) => Promise<Step<I, O> | null>;

export function semanticSwitch<I, O>(
  opts: SemanticSwitchAdvanced<I, O>,
): (input: I, ctx: Context) => Promise<Step<I, O> | null>;

export function semanticSwitch<I, O>(
  opts: SemanticSwitchSimple<I, O> | SemanticSwitchAdvanced<I, O>,
): (input: I, ctx: Context) => Promise<Step<I, O> | null> {
  const threshold = opts.threshold ?? 0.7;

  // Normalize to advanced form
  const cases: {
    labels: string[];
    step: Step<I, O>;
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

  return async (input: I, _ctx: Context): Promise<Step<I, O> | null> => {
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

export function embeddingMatch<I>(embed: EmbedFn, label: string, threshold: number): Condition<I>;

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

export function aiCondition<I>(opts: {
  callModel: CallModelFn;
  model: string;
  prompt: string;
}): Condition<I> {
  return async (input: I, ctx: Context): Promise<boolean> => {
    const text = serializeInput(input);
    const systemPrompt = `You are a boolean classifier. Given the user's input, answer the following question with JSON: {"answer": true} or {"answer": false}.\n\nQuestion: ${opts.prompt}`;
    const items = [
      createMessage(systemPrompt, 'developer'),
      createMessage(text, 'user'),
    ];

    const response = await opts.callModel({
      model: opts.model,
      items,
      ctx,
      params: {
        temperature: 0,
      },
    });

    const responseText = extractAssistantText(response.items);

    try {
      const parsed = JSON.parse(responseText);
      const result = AiConditionResponseSchema.parse(parsed);
      return result.answer;
    } catch {
      return false;
    }
  };
}

//#endregion
