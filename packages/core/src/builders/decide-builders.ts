import type {
  AnsweredAll,
  CaseKeyOf,
  Context,
  ContextData,
  DecideAnswer,
  DecideAnswers,
  DecideQuestions,
  DecideStep,
  DecideView,
  Lazy,
  ProjectionPolicy,
  Step,
  StepConditional,
  StepEmitItems,
  StepReplay,
} from '@noetic-tools/types';
import {
  DecideQuestionsSchema,
  frameworkCast,
  NoeticConfigError,
  routeOutcomes,
} from '@noetic-tools/types';
import { getDefaultRegistrar } from '../types/step-registrar';
import { conditional } from './control-flow-builders';

//#region Types

/** @public Options for `decide()`. */
export interface StepDecideOpts<TContext, Q extends DecideQuestions, I = unknown>
  extends StepReplay<TContext, I>,
    StepEmitItems<TContext, I, DecideAnswers<Q>> {
  id: string;
  /** Decision model id. Falls back to `harness.config.decisionModel`. */
  model?: Lazy<string, TContext>;
  /** Shared framing for every question. */
  instructions?: Lazy<string | undefined, TContext>;
  questions: Q & NonEmpty<Q>;
  /** Which part of the assembled view the model sees. Default `'full'`. */
  view?: DecideView;
  /**
   * Typed state read from context layers, sent under one `context` state entry.
   * Annotate the parameter (`(ctx: Context<MyContext>) => …`) to type `ctx.context`.
   */
  context?: (ctx: Context<TContext>) => Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Budget for the decision's view. Defaults to `DECISION_PROJECTION`. */
  projection?: ProjectionPolicy;
  /** Runs averaged on the estimated path. Ignored on the native path. Default 1. */
  samples?: number;
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
}

/** An empty question map is a type error, not just a build-time one. */
type NonEmpty<Q> = keyof Q extends never
  ? {
      'decide needs at least one question': never;
    }
  : unknown;

import type { StepInput, StepOutput } from '@noetic-tools/types';

export type { StepInput, StepOutput };

/** A step of any kind, as far as a case needs to be one. */
type CaseStep = Pick<Step, 'kind' | 'id'>;

/** Maps every key the switch does not route to onto `never`, so a misspelled case is a type error. */
type OnlyKeys<Cases, Keys extends PropertyKey> = {
  [P in Exclude<keyof Cases, Keys>]: never;
};

/**
 * @public `routeSwitch` options that route by one question. `cases` needs exactly
 * one step per outcome; refusals and low-confidence answers take `uncertain`.
 */
export interface RouteSwitchByKeyOpts<
  TContext,
  Q extends DecideQuestions,
  K extends keyof Q & string,
  Cases extends Record<CaseKeyOf<Q[K]>, CaseStep>,
  U extends CaseStep,
> extends StepReplay<TContext> {
  id: string;
  decide: DecideStep<TContext, unknown, Q>;
  on: K;
  cases: Cases & OnlyKeys<Cases, CaseKeyOf<Q[K]>>;
  /** Below this confidence, take `uncertain`. */
  minConfidence?: number;
  /** Taken on refusal, or when confidence is below `minConfidence`. */
  uncertain: U;
}

/** @public `routeSwitch` options that combine answers in a function; `default` catches the rest. */
export interface RouteSwitchByFunctionOpts<
  TContext,
  Q extends DecideQuestions,
  C extends string,
  Cases extends Partial<Record<C, CaseStep>>,
  D extends CaseStep,
  U extends CaseStep,
> extends StepReplay<TContext> {
  id: string;
  decide: DecideStep<TContext, unknown, Q>;
  /** Receives answers with refusals already handled. */
  on: (answers: AnsweredAll<Q>) => C;
  cases: Cases & OnlyKeys<Cases, C>;
  default: D;
  /** Taken when any answer is refused. Defaults to `default`. */
  uncertain?: U;
}

//#endregion

//#region Public API

/**
 * Creates a step that asks a model typed questions and returns typed answers
 * with probabilities. See spec 32.
 *
 * The question map comes first among the type parameters so it is always
 * inferred: pass no type arguments, and get a typed `ctx.context` by annotating
 * the selector — `context: (ctx: Context<MyContext>) => …`.
 *
 * @public
 * @throws `NoeticConfigError` `EMPTY_STEP_ID`, `MISSING_MODEL` (empty eager model),
 *   `INVALID_DECIDE_QUESTIONS`, or `INVALID_DECIDE_SAMPLES`.
 */
export function decide<const Q extends DecideQuestions, TContext = ContextData, I = unknown>(
  opts: StepDecideOpts<TContext, Q, I>,
): DecideStep<TContext, I, Q> {
  requireId('decide', opts.id);
  if (typeof opts.model === 'string' && opts.model.trim() === '') {
    throw new NoeticConfigError({
      code: 'MISSING_MODEL',
      message: 'decide() was given an empty model.',
      hint: "Pass a model id, e.g. model: 'typesafe/jev-1.14', or omit it to use the harness `decisionModel`.",
    });
  }
  const parsed = DecideQuestionsSchema.safeParse(opts.questions);
  if (!parsed.success) {
    throw new NoeticConfigError({
      code: 'INVALID_DECIDE_QUESTIONS',
      message: `decide(${JSON.stringify(opts.id)}) has invalid questions: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      hint: 'Give 1+ questions; booleans need instructions or criteria, choices 1–255 unique values, scores 2–10 unique levels.',
    });
  }
  const samples = opts.samples ?? 1;
  if (!Number.isInteger(samples) || samples < 1) {
    throw new NoeticConfigError({
      code: 'INVALID_DECIDE_SAMPLES',
      message: `decide(${JSON.stringify(opts.id)}) has samples=${samples}; it must be a positive integer.`,
      hint: 'Omit samples, or pass a whole number of runs to average, e.g. samples: 3.',
    });
  }
  const built: DecideStep<TContext, I, Q> = {
    ...opts,
    kind: 'decide',
    view: opts.view ?? 'full',
    samples,
  };
  getDefaultRegistrar().register(built);
  return built;
}

/**
 * Creates a conditional step that runs a decide step and routes the original input to
 * the case its answers pick. The output type is the union of every case's
 * output. See spec 32.
 *
 * @public
 * @throws `NoeticConfigError` `EMPTY_STEP_ID`, `UNKNOWN_ROUTE_QUESTION`,
 *   `INCOMPLETE_ROUTE_CASES`, `INVALID_MIN_CONFIDENCE`, or `MISSING_UNCERTAIN_STEP`.
 */
export function routeSwitch<
  TContext,
  const Q extends DecideQuestions,
  const C extends string,
  const Cases extends Partial<Record<C, CaseStep>>,
  D extends CaseStep,
  U extends CaseStep = D,
>(
  opts: RouteSwitchByFunctionOpts<TContext, Q, C, Cases, D, U>,
): StepConditional<
  TContext,
  StepInput<Cases[keyof Cases] | D | U>,
  StepOutput<Cases[keyof Cases] | D | U>
>;
// The key form is the last overload because TypeScript reports only the last
// one's error, and the key form is the one most calls use.
export function routeSwitch<
  TContext,
  const Q extends DecideQuestions,
  const K extends keyof Q & string,
  const Cases extends Record<CaseKeyOf<Q[K]>, CaseStep>,
  U extends CaseStep,
>(
  opts: RouteSwitchByKeyOpts<TContext, Q, K, Cases, U>,
): StepConditional<TContext, StepInput<Cases[keyof Cases] | U>, StepOutput<Cases[keyof Cases] | U>>;
export function routeSwitch(opts: SwitchPlan): StepConditional<ContextData, unknown, unknown> {
  requireId('routeSwitch', opts.id);
  return buildSwitch({
    id: opts.id,
    decide: opts.decide,
    on: opts.on,
    cases: opts.cases,
    minConfidence: 'minConfidence' in opts ? opts.minConfidence : undefined,
    uncertain: opts.uncertain,
    default: 'default' in opts ? opts.default : undefined,
    durable: opts.durable,
    replayKey: opts.replayKey,
  });
}

//#endregion

//#region Routing

/** Both option shapes, loosened to what the runtime needs. */
interface SwitchPlan extends StepReplay {
  id: string;
  decide: DecideStep<ContextData, unknown, DecideQuestions>;
  on: string | ((answers: AnsweredAll<DecideQuestions>) => string);
  cases: Partial<Record<string, CaseStep>>;
  minConfidence?: number;
  uncertain?: CaseStep;
  default?: CaseStep;
}

interface Picked {
  step: Step | null;
  /** Case taken, `uncertain`, or `default`. */
  label: string;
}

/**
 * Builds the conditional. Its route closes over the plan, so `_rebuild` rebuilds it
 * around new children for the optimizer, in the same order as `_optimizable`.
 */
function buildSwitch(plan: SwitchPlan): StepConditional<ContextData, unknown, unknown> {
  const keys = Object.keys(plan.cases).filter((k) => plan.cases[k] !== undefined);
  const pick = typeof plan.on === 'function' ? byFunction(plan, plan.on) : byKey(plan, plan.on);
  const children = [
    plan.decide,
    ...keys.map((k) => plan.cases[k]),
    ...(plan.uncertain
      ? [
          plan.uncertain,
        ]
      : []),
    ...(plan.default
      ? [
          plan.default,
        ]
      : []),
  ];
  return conditional<ContextData, unknown, unknown>({
    id: plan.id,
    durable: plan.durable,
    replayKey: plan.replayKey,
    route: async (input, ctx, run) => {
      const answers = frameworkCast<Record<string, DecideAnswer>>(
        await run(plan.decide, input, ctx),
      );
      const picked = pick(answers);
      ctx.span.addEvent('route_switch', {
        stepId: plan.id,
        case: picked.label,
      });
      return picked.step;
    },
    _optimizable: frameworkCast<Step[]>(children),
    _rebuild: (next) => {
      let i = 1;
      const take = (): CaseStep => frameworkCast<CaseStep>(next[i++]);
      return buildSwitch({
        ...plan,
        decide: frameworkCast(next[0]),
        cases: Object.fromEntries(
          keys.map((k) => [
            k,
            take(),
          ]),
        ),
        uncertain: plan.uncertain ? take() : undefined,
        default: plan.default ? take() : undefined,
      });
    },
  });
}

function byKey(plan: SwitchPlan, on: string): (answers: Record<string, DecideAnswer>) => Picked {
  const questions = plan.decide.questions;
  const question = Object.hasOwn(questions, on) ? questions[on] : undefined;
  if (!question) {
    throw new NoeticConfigError({
      code: 'UNKNOWN_ROUTE_QUESTION',
      message: `routeSwitch(${JSON.stringify(plan.id)}) routes on '${on}', which its decide step does not ask.`,
      hint: `Set \`on\` to one of: ${Object.keys(questions).join(', ')}.`,
    });
  }
  const missing = routeOutcomes(question).filter((o) => !caseFor(plan, o));
  if (missing.length > 0) {
    throw new NoeticConfigError({
      code: 'INCOMPLETE_ROUTE_CASES',
      message: `routeSwitch(${JSON.stringify(plan.id)}) has no case for: ${missing.join(', ')}.`,
      hint: `Give a case for every outcome of '${on}'.`,
    });
  }
  const uncertain = requireUncertain(plan);
  return (answers) => {
    const answer = Object.hasOwn(answers, on) ? answers[on] : undefined;
    if (!answer || answer.type === 'refusal') {
      return uncertain;
    }
    if (plan.minConfidence !== undefined && confidenceOf(answer) < plan.minConfidence) {
      return uncertain;
    }
    const key = caseKey(answer);
    return {
      step: caseFor(plan, key),
      label: key,
    };
  };
}

function byFunction(
  plan: SwitchPlan,
  on: (answers: AnsweredAll<DecideQuestions>) => string,
): (answers: Record<string, DecideAnswer>) => Picked {
  const fallback: Picked = {
    step: frameworkCast<Step | null>(plan.default ?? null),
    label: 'default',
  };
  const refused: Picked = plan.uncertain
    ? {
        step: frameworkCast<Step>(plan.uncertain),
        label: 'uncertain',
      }
    : fallback;
  return (answers) => {
    if (Object.values(answers).some((a) => a.type === 'refusal')) {
      return refused;
    }
    const key = on(frameworkCast<AnsweredAll<DecideQuestions>>(answers));
    const step = caseFor(plan, key);
    return step
      ? {
          step,
          label: key,
        }
      : fallback;
  };
}

/** Own keys only: a choice named `constructor` must not find `Object.prototype.constructor`. */
function caseFor(plan: SwitchPlan, key: string): Step | null {
  return Object.hasOwn(plan.cases, key)
    ? frameworkCast<Step | null>(plan.cases[key] ?? null)
    : null;
}

function caseKey(
  answer: Exclude<
    DecideAnswer,
    {
      type: 'refusal';
    }
  >,
): string {
  switch (answer.type) {
    case 'boolean':
      return String(answer.value);
    case 'choice':
      return answer.value;
    case 'score':
      return answer.level;
  }
}

/**
 * Choice and score use the provider's `confidence`. A boolean has none, so it
 * uses the probability of the side `value` picked — which respects the
 * question's `threshold`, unlike distance from a coin flip.
 */
function confidenceOf(
  answer: Exclude<
    DecideAnswer,
    {
      type: 'refusal';
    }
  >,
): number {
  if (answer.type !== 'boolean') {
    return answer.confidence;
  }
  return answer.value ? answer.probability : 1 - answer.probability;
}

//#endregion

//#region Helpers

function requireId(builder: string, id: string): void {
  if (!id || id.trim() === '') {
    throw new NoeticConfigError({
      code: 'EMPTY_STEP_ID',
      message: `${builder}() requires a non-empty id.`,
      hint: `Pass a unique string as the id field, e.g. ${builder}({ id: "triage", ... }).`,
    });
  }
}

function requireUncertain(plan: SwitchPlan): Picked {
  if (plan.minConfidence !== undefined && (plan.minConfidence < 0 || plan.minConfidence > 1)) {
    throw new NoeticConfigError({
      code: 'INVALID_MIN_CONFIDENCE',
      message: `routeSwitch(${JSON.stringify(plan.id)}) has minConfidence=${plan.minConfidence}; it must be in [0, 1].`,
      hint: 'Pass a confidence between 0 and 1, e.g. minConfidence: 0.6.',
    });
  }
  if (!plan.uncertain) {
    throw new NoeticConfigError({
      code: 'MISSING_UNCERTAIN_STEP',
      message: `routeSwitch(${JSON.stringify(plan.id)}) has no uncertain step.`,
      hint: 'Pass `uncertain`: the step to run when the model refuses or is not confident enough.',
    });
  }
  return {
    step: frameworkCast<Step>(plan.uncertain),
    label: 'uncertain',
  };
}

//#endregion
