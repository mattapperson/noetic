import type { ZodType } from 'zod';
import { z } from 'zod';
import { loop } from '../builders/loop-builder';
import { step } from '../builders/step-builders';
import { frameworkCast } from '../interpreter/framework-cast';
import type { Context } from '../types/context';
import type { ContextMemory } from '../types/memory';
import type { Step } from '../types/step';
import { any } from '../until/combinators';
import { until } from '../until/predicates';

//#region Types

/** @public Answer captured by the host for a single interview question. */
export interface InterviewQuestionAnswer {
  questionId: string;
  question: string;
  answer: string | string[];
  notes?: string;
}

/** @public Result of running an `interview()` step. */
export type InterviewResult<Q, C> =
  | {
      status: 'complete';
      envelope: C;
    }
  | {
      status: 'maxQuestions';
      lastQuestion?: Q;
    };

/** @public Configuration for the `interview()` pattern. */
export interface InterviewOpts<Q, C> {
  /** System prompt instructing the model on how to interview the user. */
  systemPrompt: string;
  /** Model identifier passed to `step.llm`. */
  model: string;
  /** Zod schema for the `data` payload of a `question` envelope. */
  questionSchema: ZodType<Q>;
  /** Zod schema for the `data` payload of a `complete` envelope. */
  completeSchema: ZodType<C>;
  /** Host renders the question (e.g. via AskUserService) and returns the answer. */
  askQuestion: (envelope: Q) => Promise<InterviewQuestionAnswer>;
  /** Called once when the model emits the complete envelope. */
  onComplete: (envelope: C) => Promise<void>;
  /** Hard cap on question/complete turns before the loop exits with `maxQuestions`. Default 8. */
  maxQuestions?: number;
  /**
   * Override how a captured answer becomes the next user message. Default emits a
   * compact, machine-readable JSON line that the model can parse to build context.
   */
  formatAnswer?: (answer: InterviewQuestionAnswer) => string;
}

//#endregion

//#region Internal types

interface IterStateInProgress<Q> {
  status: 'inProgress';
  lastQuestion: Q;
  nextInput: string;
}

interface IterStateComplete<C> {
  status: 'complete';
  envelope: C;
  nextInput: '';
}

type IterState<Q, C> = IterStateInProgress<Q> | IterStateComplete<C>;

type Envelope<Q, C> =
  | {
      type: 'question';
      data: Q;
    }
  | {
      type: 'complete';
      data: C;
    };

//#endregion

//#region Helpers

const DEFAULT_MAX_QUESTIONS = 8;

function defaultFormatAnswer(answer: InterviewQuestionAnswer): string {
  return JSON.stringify({
    questionId: answer.questionId,
    question: answer.question,
    answer: answer.answer,
    notes: answer.notes,
  });
}

function isCompleteIterState(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('status' in value)) {
    return false;
  }
  return value.status === 'complete';
}

function buildEnvelopeSchema<Q, C>(
  questionSchema: ZodType<Q>,
  completeSchema: ZodType<C>,
): ZodType<Envelope<Q, C>> {
  const schema = z.discriminatedUnion('type', [
    z.object({
      type: z.literal('question'),
      data: questionSchema,
    }),
    z.object({
      type: z.literal('complete'),
      data: completeSchema,
    }),
  ]);
  // ZodDiscriminatedUnion narrows to a non-generic ZodType<Envelope> shape, but
  // step.llm's `output` field is typed as ZodType<O> for the generic O.
  return frameworkCast<ZodType<Envelope<Q, C>>>(schema);
}

//#endregion

//#region Public API

/**
 * Creates a host-callback-driven structured interview pattern. Internally a loop over a single
 * body step that delegates to `step.llm` (with `output: discriminatedUnion('type', [...])`) and
 * then hands the envelope to the host. `askQuestion` renders questions and returns answers fed
 * back as the next user message; `onComplete` fires once when the model emits `complete`.
 * Termination via `until.verified(complete) || until.maxSteps(maxQuestions)`.
 *
 * @public
 * @param opts - System prompt, model, question/complete schemas, host callbacks, optional caps.
 * @returns A `Step` whose output is `InterviewResult<Q, C>` — either the completion envelope or
 *          `maxQuestions` when the budget is exhausted before the model emits `complete`.
 */
export function interview<Q, C>(
  opts: InterviewOpts<Q, C>,
): Step<ContextMemory, string, InterviewResult<Q, C>> {
  const maxQuestions = opts.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  const formatAnswer = opts.formatAnswer ?? defaultFormatAnswer;
  const envelopeSchema = buildEnvelopeSchema(opts.questionSchema, opts.completeSchema);

  const llmStep = step.llm<ContextMemory, string, Envelope<Q, C>>({
    id: 'interview-llm',
    model: opts.model,
    instructions: opts.systemPrompt,
    output: envelopeSchema,
  });

  const turnStep = step.run<ContextMemory, string, IterState<Q, C>>({
    id: 'interview-turn',
    execute: async (input: string, ctx: Context<ContextMemory>) => {
      const envelope = await ctx.harness.run(llmStep, input, ctx);
      if (envelope.type === 'complete') {
        await opts.onComplete(envelope.data);
        return {
          status: 'complete',
          envelope: envelope.data,
          nextInput: '',
        };
      }
      const answer = await opts.askQuestion(envelope.data);
      return {
        status: 'inProgress',
        lastQuestion: envelope.data,
        nextInput: formatAnswer(answer),
      };
    },
  });

  const loopStep = loop<ContextMemory, string, IterState<Q, C>>({
    id: 'interview-loop',
    steps: [
      turnStep,
    ],
    until: any(
      until.verified(async (out) => ({
        pass: isCompleteIterState(out),
      })),
      until.maxSteps(maxQuestions),
    ),
    prepareNext: (output) => output.nextInput,
  });

  return step.run<ContextMemory, string, InterviewResult<Q, C>>({
    id: 'interview',
    execute: async (input: string, ctx: Context<ContextMemory>) => {
      const final = await ctx.harness.run(loopStep, input, ctx);
      if (final.status === 'complete') {
        return {
          status: 'complete',
          envelope: final.envelope,
        };
      }
      return {
        status: 'maxQuestions',
        lastQuestion: final.lastQuestion,
      };
    },
  });
}

//#endregion
