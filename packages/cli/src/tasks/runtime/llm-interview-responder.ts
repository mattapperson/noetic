/**
 * LLM-backed `askQuestion` responder for the autonomous planner.
 *
 * The TUI's planner uses `AskUserService` to render multiple-choice
 * questions; the daemon's planner has no human in the loop, so the
 * `interview()` pattern (`@noetic-tools/core/patterns/interview`) needs an
 * LLM to answer on the user's behalf using only the manual task's
 * title + description as context.
 *
 * This module exposes {@link createLlmInterviewResponder}, which
 * returns an `(envelope) => Promise<InterviewQuestionAnswer>`
 * callable matching the `interview()` host-callback contract. Inside
 * the callable, a Step graph drives a parse-retry loop:
 *
 *   loop({
 *     steps: [askAndParseStep],
 *     until: any(until.verified(checkOk), until.maxSteps(N)),
 *     prepareNext: (out, verdict) => buildPromptWithFeedback(verdict.feedback),
 *   })
 *
 * The body step performs `harness.run(rawLlmStep, prompt)` and catches
 * `llm_parse_error` to surface the failure as data instead of an
 * exception. The verifier then re-issues the prompt with the parse
 * error appended so the next LLM call sees what to fix. Caps retries
 * at {@link RESPONDER_MAX_RETRIES} so a permanently-failing model
 * doesn't burn tokens indefinitely.
 */

import type { Context, ContextMemory, InterviewQuestionAnswer, Step } from '@noetic-tools/core';
import { any, isNoeticError, loop, step, until } from '@noetic-tools/core';
import { z } from 'zod';

import type { InterviewQuestionEnvelope } from './hierarchy/live-interview.js';

//#region Schema

const InterviewQuestionAnswerSchema = z.object({
  questionId: z.string(),
  question: z.string(),
  answer: z.union([
    z.string(),
    z.array(z.string()),
  ]),
  notes: z.string().optional(),
});

//#endregion

//#region Types

export interface LlmInterviewResponderOpts {
  /**
   * Context whose `harness` field drives sub-step.run calls. The responder
   * uses `ctx.harness.run(...)` so callers don't need to thread an
   * `AgentHarness` reference separately.
   */
  readonly ctx: Context<ContextMemory>;
  readonly model: string;
  /** Manual task title; primary context the LLM has to answer questions. */
  readonly taskTitle: string;
  /** Optional manual task description. Empty string when absent. */
  readonly taskDescription: string;
  /** Override the default retry budget — primarily a test seam. */
  readonly maxRetries?: number;
}

/**
 * Outcome of one parse attempt — `ok: true` carries the parsed answer,
 * `ok: false` carries the parse error message that the loop's verifier
 * forwards into the next iteration's prompt.
 */
export interface ResponderResult {
  readonly ok: boolean;
  readonly value?: InterviewQuestionAnswer;
  readonly error?: string;
}

//#endregion

//#region Constants

const ANSWER_SYSTEM_PROMPT = [
  'You are answering structured-interview questions on behalf of a user',
  'who has authored a manual task in a code-agent system. Answer each',
  'question concisely using ONLY the supplied task title + description as',
  'context. Choose from the provided options when the question is',
  'multiple-choice; emit free text when the question type is `text`.',
  'Always echo back the question id and question verbatim in your',
  'response so the surrounding interview loop can correlate answers to',
  'questions.',
].join(' ');

export const RESPONDER_MAX_RETRIES = 3;

//#endregion

//#region Helpers

export function buildAnswerPrompt(args: {
  envelope: InterviewQuestionEnvelope;
  taskTitle: string;
  taskDescription: string;
}): string {
  const lines: string[] = [];
  lines.push('# Task');
  lines.push(`Title: ${args.taskTitle}`);
  if (args.taskDescription.length > 0) {
    lines.push('', 'Description:', args.taskDescription);
  }
  lines.push('', '# Question to answer');
  lines.push(`questionId: ${args.envelope.id}`);
  lines.push(`type: ${args.envelope.type}`);
  lines.push(`question: ${args.envelope.question}`);
  if (args.envelope.description !== undefined && args.envelope.description.length > 0) {
    lines.push(`description: ${args.envelope.description}`);
  }
  if (args.envelope.options !== undefined && args.envelope.options.length > 0) {
    lines.push('options:');
    for (const opt of args.envelope.options) {
      const desc = opt.description !== undefined ? ` — ${opt.description}` : '';
      lines.push(`  - id="${opt.id}" label="${opt.label}"${desc}`);
    }
  }
  lines.push('');
  lines.push(
    args.envelope.type === 'multi_select'
      ? 'Return `answer` as an array of selected option labels (or ids).'
      : 'Return `answer` as a single string (the chosen label, "Yes"/"No" for confirms, or free text).',
  );
  return lines.join('\n');
}

export function buildRetryPrompt(args: { basePrompt: string; feedback: string }): string {
  return `${args.basePrompt}\n\n## Prior attempt rejected by the parser\n${args.feedback}\n\nRe-emit valid JSON that matches the InterviewQuestionAnswer schema exactly. Do not include any prose.`;
}

/**
 * Decide whether a {@link ResponderResult} represents a successful parse.
 * Returns the verifier verdict consumed by `until.verified`.
 */
export function buildResponderVerdict(out: unknown): {
  pass: boolean;
  feedback?: string;
} {
  if (isResponderResult(out) && out.ok && out.value !== undefined) {
    return {
      pass: true,
    };
  }
  const error = isResponderResult(out) ? (out.error ?? 'unknown parse error') : 'unknown';
  return {
    pass: false,
    feedback: error,
  };
}

function isResponderResult(value: unknown): value is ResponderResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!('ok' in value)) {
    return false;
  }
  return typeof value.ok === 'boolean';
}

/**
 * Extract the parse-error message from a `llm_parse_error` `NoeticError`.
 * Pure function so the test suite can pin the exact format.
 */
export function formatParseError(zodMessage: string, raw: string): string {
  const trimmedRaw = raw.length > 500 ? `${raw.slice(0, 500)}…[truncated]` : raw;
  return `${zodMessage}\n\n--- raw output ---\n${trimmedRaw}\n--- end raw output ---`;
}

//#endregion

//#region Public API

/**
 * Build an LLM-driven `askQuestion` callback for the `interview()`
 * pattern. Each invocation runs a Step-graph parse-retry loop against
 * the supplied harness; the LLM returns a Zod-validated
 * {@link InterviewQuestionAnswer}, with up to {@link RESPONDER_MAX_RETRIES}
 * additional attempts when the model emits malformed JSON.
 */
export function createLlmInterviewResponder(
  opts: LlmInterviewResponderOpts,
): (envelope: InterviewQuestionEnvelope) => Promise<InterviewQuestionAnswer> {
  const maxRetries = opts.maxRetries ?? RESPONDER_MAX_RETRIES;

  // Inner LLM step — the schema-typed `step.llm` throws `llm_parse_error`
  // on malformed JSON; the surrounding `step.run` catches that throw and
  // surfaces it as data so the loop's verifier can drive the retry.
  const llmStep: Step<ContextMemory, string, InterviewQuestionAnswer> = step.llm({
    id: 'planner.llm-interview-responder.llm',
    model: opts.model,
    instructions: ANSWER_SYSTEM_PROMPT,
    output: InterviewQuestionAnswerSchema,
  });

  const askAndParseStep: Step<ContextMemory, string, ResponderResult> = step.run({
    id: 'planner.llm-interview-responder.askAndParse',
    execute: async (prompt, ctx) => {
      try {
        const value = await ctx.harness.run(llmStep, prompt, ctx);
        return {
          ok: true,
          value,
        };
      } catch (err) {
        if (isNoeticError(err) && err.noeticError.kind === 'llm_parse_error') {
          return {
            ok: false,
            error: formatParseError(err.noeticError.zodError.message, err.noeticError.raw),
          };
        }
        throw err;
      }
    },
  });

  return async (envelope) => {
    const basePrompt = buildAnswerPrompt({
      envelope,
      taskTitle: opts.taskTitle,
      taskDescription: opts.taskDescription,
    });

    const responderLoop = loop<ContextMemory, string, ResponderResult>({
      id: 'planner.llm-interview-responder.loop',
      steps: [
        askAndParseStep,
      ],
      maxIterations: maxRetries + 1,
      until: any(
        until.verified(async (out) => buildResponderVerdict(out)),
        until.maxSteps(maxRetries + 1),
      ),
      prepareNext: (_lastOutput, verdict) =>
        buildRetryPrompt({
          basePrompt,
          feedback: verdict.feedback ?? 'unknown parse error',
        }),
    });

    const result = await opts.ctx.harness.run(responderLoop, basePrompt, opts.ctx);
    if (!result.ok || result.value === undefined) {
      throw new Error(
        `LLM interview responder exhausted ${maxRetries} retries: ${result.error ?? 'unknown error'}`,
      );
    }
    return result.value;
  };
}

//#endregion
