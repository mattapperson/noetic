/**
 * Drives the real `@noetic-tools/code-agent` against a single LongMemEval
 * question. The agent is built with its default Noetic memory stack and its
 * configured OpenRouter provider; we run a question-answering `step.llm`
 * through the agent's harness (`agent.run`), which is how the code-agent
 * package exposes single-shot model turns to embedders.
 *
 * A LongMemEval question is pure memory-recall QA: the full evidence history is
 * supplied in the prompt and the agent must locate and synthesize the answer.
 * No files are touched, so the read-only QA step is the faithful surface.
 */

import { createCodeAgent } from '@noetic-tools/code-agent';
import { step } from '@noetic-tools/core';
import type { LongMemQuestion } from './dataset';
import { buildQuestionPrompt, isAbstentionQuestion } from './dataset';

//#region Types

export interface AnswerResult {
  readonly questionId: string;
  readonly answer: string;
  readonly elapsedMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number;
}

export interface AnswerOptions {
  /** OpenRouter model id. */
  readonly model: string;
  /** OpenRouter key. Defaults to OPENROUTER_API_KEY from the environment. */
  readonly apiKey?: string;
}

//#endregion

//#region Instructions

const QA_INSTRUCTIONS = [
  'You are a helpful assistant with long-term memory of your prior conversations',
  'with the user. You will be shown the relevant prior conversation history,',
  'followed by a new question from the user.',
  '',
  'Answer the question directly and concisely using only the facts present in',
  'the conversation history. Pay attention to the session timestamps when the',
  'question involves time ("first", "most recent", "after", "before").',
  'If the history does not contain enough information to answer, say so plainly.',
  'Respond with the answer only — no preamble, no restating the question.',
].join('\n');

//#endregion

//#region Public API

/**
 * Runs the code agent on one question and returns its answer plus usage metrics.
 * Each call uses a fresh agent so questions never leak memory into each other.
 */
export async function answerWithCodeAgent(
  question: LongMemQuestion,
  options: AnswerOptions,
): Promise<AnswerResult> {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set (and no apiKey option provided).');
  }

  const agent = await createCodeAgent({
    name: 'longmem-code-agent',
    model: options.model,
    cwd: '/longmem',
    llm: {
      provider: 'openrouter',
      apiKey,
    },
  });

  const qaStep = step.llm({
    id: 'longmem-qa',
    model: options.model,
    instructions: QA_INSTRUCTIONS,
  });

  try {
    const prompt = buildQuestionPrompt(question);
    const ctx = agent.createContext();
    const start = performance.now();
    const output = await agent.run(qaStep, prompt, ctx);
    const elapsedMs = performance.now() - start;

    return {
      questionId: question.question_id,
      answer: String(output).trim(),
      elapsedMs,
      inputTokens: ctx.tokens.input,
      outputTokens: ctx.tokens.output,
      cost: ctx.cost,
    };
  } finally {
    await agent.dispose();
  }
}

export { isAbstentionQuestion };

//#endregion
