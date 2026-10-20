import type { ZodError, ZodType } from 'zod';
import { z } from 'zod';
import type { Span } from './observability';

//#region Questions

/** @public A yes/no question. The answer's `value` is `probability >= threshold`. */
export interface BooleanQuestion {
  type: 'boolean';
  instructions?: string;
  /** What yes and no mean. Required when `instructions` is absent. */
  criteria?: {
    true?: string;
    false?: string;
  };
  /** Probability at or above which `value` is `true`. Default 0.5. */
  threshold?: number;
}

/** @public Pick one of a set of unordered options. */
export interface ChoiceQuestion<K extends string = string> {
  type: 'choice';
  instructions?: string;
  /** 1–255 options: bare values, or values mapped to descriptions. */
  choices: readonly K[] | Readonly<Record<K, string>>;
}

/** @public A level on an ordered scale. */
export interface ScoreLevel<L extends string = string> {
  label: L;
  description?: string;
}

/**
 * @public Place the state on an ordered scale. Levels run lowest first, and are
 * an array because a record cannot carry order: JavaScript sorts integer-like
 * keys ahead of all others.
 */
export interface ScoreQuestion<L extends string = string> {
  type: 'score';
  instructions?: string;
  /** 2–10 levels, lowest first. */
  levels: readonly L[] | ReadonlyArray<ScoreLevel<L>>;
}

/** @public Any decide question. */
export type DecideQuestion = BooleanQuestion | ChoiceQuestion | ScoreQuestion;

/** @public Question map keyed by question id. */
export type DecideQuestions = Readonly<Record<string, DecideQuestion>>;

//#endregion

//#region Answers

/** @public Answer to a boolean question. */
export interface BooleanAnswer {
  type: 'boolean';
  /** `probability >= threshold`. */
  value: boolean;
  /** Probability of yes, in `[0, 1]`. */
  probability: number;
}

/** @public Answer to a choice question. */
export interface ChoiceAnswer<K extends string = string> {
  type: 'choice';
  /** The most probable choice. */
  value: K;
  /** The provider's own certainty measure — not the top probability. */
  confidence: number;
  probabilities: Readonly<Record<K, number>>;
}

/** @public Answer to a score question. */
export interface ScoreAnswer<L extends string = string> {
  type: 'score';
  /** Probability-weighted level index, 0 = lowest. */
  value: number;
  /** The most probable level. Not `value` rounded: a split distribution can differ. */
  level: L;
  /** The provider's own certainty measure — not the top probability. */
  confidence: number;
  probabilities: Readonly<Record<L, number>>;
}

/** @public The model declined to answer this question. */
export interface Refusal {
  type: 'refusal';
}

/** @public Any answer, untyped by question. */
export type DecideAnswer = BooleanAnswer | ChoiceAnswer | ScoreAnswer | Refusal;

/** @public Choice values declared by a choice question's `choices`. */
export type ChoiceValues<C> = C extends readonly (infer K extends string)[]
  ? K
  : C extends Readonly<Record<infer K extends string | number, string>>
    ? `${K}`
    : never;

/** @public Level labels declared by a score question's `levels`. */
export type LevelLabels<L> = L extends readonly (infer E)[]
  ? E extends string
    ? E
    : E extends {
          label: infer K extends string;
        }
      ? K
      : never
  : never;

/** @public The answer type a question produces, refusal excluded. */
export type AnswerFor<Q> = Q extends {
  type: 'boolean';
}
  ? BooleanAnswer
  : Q extends {
        type: 'choice';
        choices: infer C;
      }
    ? ChoiceAnswer<ChoiceValues<C>>
    : Q extends {
          type: 'score';
          levels: infer L;
        }
      ? ScoreAnswer<LevelLabels<L>>
      : never;

/** @public Typed answers for a question map. Any question may be refused. */
export type DecideAnswers<Q extends DecideQuestions> = {
  readonly [K in keyof Q]: AnswerFor<Q[K]> | Refusal;
};

/** @public Case keys a question routes to: its choices, `'true' | 'false'`, or its level labels. */
export type CaseKeyOf<Q> = Q extends {
  type: 'boolean';
}
  ? 'true' | 'false'
  : Q extends {
        type: 'choice';
        choices: infer C;
      }
    ? ChoiceValues<C>
    : Q extends {
          type: 'score';
          levels: infer L;
        }
      ? LevelLabels<L>
      : never;

/** @public Typed answers with refusals removed. */
export type AnsweredAll<Q extends DecideQuestions> = {
  readonly [K in keyof Q]: AnswerFor<Q[K]>;
};

//#endregion

//#region Harness Contract

/** @public One piece of the state a decision is made against. */
export type DecideStatePart =
  | {
      type: 'text';
      text: string;
      name?: string;
    }
  | {
      type: 'json';
      name: string;
      value: unknown;
    }
  | {
      type: 'image';
      imageUrl: string;
    };

/**
 * @public `native`: a decision model's own distribution. `estimated`: a chat
 * model's self-reported probabilities, which are not calibrated.
 */
export type DecisionSource = 'native' | 'estimated';

/** @public Request for `harness.decide()`, in Noetic's vocabulary. Adapters translate it per provider. */
export interface DecideRequest {
  model: string;
  instructions?: string;
  state: ReadonlyArray<DecideStatePart>;
  questions: DecideQuestions;
  /** Runs averaged on the estimated path. Ignored on the native path. Default 1. */
  samples?: number;
  signal?: AbortSignal;
  /** @internal Parent span for the decide-call span. */
  parentSpan?: Span;
}

/** @public Response from `harness.decide()`. */
export interface DecideResponse {
  answers: Readonly<Record<string, DecideAnswer>>;
  source: DecisionSource;
  /** Model that answered, as reported by the provider. */
  modelId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  cost?: number;
}

/** @public Decision metadata recorded on `ctx.lastStepMeta.decision`. */
export interface DecisionMeta {
  modelId: string;
  source: DecisionSource;
  /** Ids of refused questions. */
  refused: readonly string[];
}

/** @public One completed decision, as layers see it through `onDecision`. */
export interface DecisionRecord {
  stepId: string;
  /** Epoch ms. */
  at: number;
  modelId: string;
  source: DecisionSource;
  answers: Readonly<Record<string, DecideAnswer>>;
}

//#endregion

/**
 * A chat model's estimate did not match the requested shape. The interpreter
 * turns it into `llm_parse_error`, which needs the step id this layer lacks.
 * @public
 */
export class DecideOutputError extends Error {
  readonly raw: string;
  readonly schema: ZodType;
  readonly zodError: ZodError;
  /** Tokens the failed estimate still cost, so the step can count them. */
  readonly usage?: DecideResponse['usage'];
  readonly cost?: number;

  constructor(opts: {
    raw: string;
    schema: ZodType;
    zodError: ZodError;
    usage?: DecideResponse['usage'];
    cost?: number;
  }) {
    super(`decision estimate did not match its schema: ${opts.zodError.message}`);
    this.name = 'DecideOutputError';
    this.raw = opts.raw;
    this.schema = opts.schema;
    this.zodError = opts.zodError;
    this.usage = opts.usage;
    this.cost = opts.cost;
  }
}

//#endregion

//#region Schemas

/** Choice and level limits shared by the OpenAI and TypeSafe decision APIs. */
export const DECIDE_LIMITS = {
  maxChoices: 255,
  minLevels: 2,
  maxLevels: 10,
} as const;

const InstructionsSchema = z.string().min(1).optional();

/** @public Zod schema for a boolean question. */
export const BooleanQuestionSchema = z
  .object({
    type: z.literal('boolean'),
    instructions: InstructionsSchema,
    criteria: z
      .object({
        true: z.string().min(1).optional(),
        false: z.string().min(1).optional(),
      })
      .optional(),
    threshold: z.number().min(0).max(1).optional(),
  })
  .refine((q) => q.instructions !== undefined || q.criteria?.true || q.criteria?.false, {
    message: 'boolean question needs `instructions` or a `criteria` description.',
  });

/** @public Zod schema for a choice question. */
export const ChoiceQuestionSchema = z
  .object({
    type: z.literal('choice'),
    instructions: InstructionsSchema,
    choices: z.union([
      z.array(z.string().min(1)).min(1).max(DECIDE_LIMITS.maxChoices),
      z.record(z.string().min(1), z.string()),
    ]),
  })
  .refine((q) => choiceValues(q.choices).length >= 1, {
    message: 'choice question needs at least one choice.',
  })
  .refine((q) => choiceValues(q.choices).length <= DECIDE_LIMITS.maxChoices, {
    message: `choice question allows at most ${DECIDE_LIMITS.maxChoices} choices.`,
  })
  .refine((q) => unique(choiceValues(q.choices)), {
    message: 'choice values must be unique.',
  });

/** @public Zod schema for a score question. */
export const ScoreQuestionSchema = z
  .object({
    type: z.literal('score'),
    instructions: InstructionsSchema,
    levels: z
      .union([
        z.array(z.string().min(1)),
        z.array(
          z.object({
            label: z.string().min(1),
            description: z.string().optional(),
          }),
        ),
      ])
      .refine((l) => l.length >= DECIDE_LIMITS.minLevels && l.length <= DECIDE_LIMITS.maxLevels, {
        message: `score question needs ${DECIDE_LIMITS.minLevels}–${DECIDE_LIMITS.maxLevels} levels.`,
      }),
  })
  .refine((q) => unique(levelLabels(q.levels)), {
    message: 'score level labels must be unique.',
  });

/** @public Zod schema for any decide question. */
export const DecideQuestionSchema = z.union([
  BooleanQuestionSchema,
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
]);

/** @public Zod schema for a question map: at least one question. */
export const DecideQuestionsSchema = z
  .record(z.string().min(1), DecideQuestionSchema)
  .refine((q) => Object.keys(q).length > 0, {
    message: 'decide needs at least one question.',
  });

//#endregion

//#region Helpers

/** @public Choice values in declaration order. */
export function choiceValues(choices: ChoiceQuestion['choices']): string[] {
  return Array.isArray(choices)
    ? [
        ...choices,
      ]
    : Object.keys(choices);
}

/** @public Score levels, lowest first, in object form. */
export function scoreLevels(levels: ScoreQuestion['levels']): ScoreLevel[] {
  return levels.map((l) =>
    typeof l === 'string'
      ? {
          label: l,
        }
      : l,
  );
}

/**
 * @public Case keys a question routes to: its choices, `'true'`/`'false'`, or
 * its level labels.
 */
export function routeOutcomes(question: DecideQuestion): string[] {
  switch (question.type) {
    case 'boolean':
      return [
        'true',
        'false',
      ];
    case 'choice':
      return choiceValues(question.choices);
    case 'score':
      return levelLabels(question.levels);
  }
}

function levelLabels(levels: ScoreQuestion['levels']): string[] {
  return scoreLevels(levels).map((l) => l.label);
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

//#endregion
