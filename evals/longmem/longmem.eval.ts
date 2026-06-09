/**
 * LongMemEval suite for the Noetic code agent, wired into `@noetic/eval`.
 *
 * The real `createCodeAgent()` harness is wrapped in a `step.run` so the eval
 * framework can drive it through `describe`/`it.each` and score its answers.
 * Each case feeds one LongMemEval (oracle) question to the agent and scores the
 * answer with a LongMemEval-style correctness judge plus semantic similarity.
 *
 * Run with the eval CLI (from the repo root):
 *   OPENROUTER_API_KEY=... bunx noetic test evals/longmem/longmem.eval.ts
 *
 * Or as a plain script (no CLI):
 *   bun evals/longmem/run.ts
 *
 * Size knobs (env): LONGMEM_LIMIT (default 1), LONGMEM_MODEL, LONGMEM_TYPE.
 */

import { describe, it, scorer } from '@noetic/eval';
import { step } from '@noetic-tools/core';

import { answerWithCodeAgent } from './agent';
import type { LongMemQuestion } from './dataset';
import { isLongMemQuestionType, loadLongMemEval } from './dataset';
import { judgeAnswer } from './judge';

//#region Config

const MODEL = process.env.LONGMEM_MODEL ?? '~anthropic/claude-sonnet-latest';
const LIMIT = Math.max(1, Number.parseInt(process.env.LONGMEM_LIMIT ?? '1', 10));
const RAW_TYPE = process.env.LONGMEM_TYPE;
const TYPE = RAW_TYPE && isLongMemQuestionType(RAW_TYPE) ? RAW_TYPE : undefined;

const questions = loadLongMemEval({
  limit: LIMIT,
  type: TYPE,
});

//#endregion

//#region Agent Step

/**
 * Wraps the real code agent as a step so the eval harness can run it. The outer
 * eval harness is a thin driver; this step spins up the full code-agent harness
 * (default Noetic memory stack) and returns its answer text.
 */
const codeAgentStep = step.run({
  id: 'longmem/code-agent',
  async execute(question: LongMemQuestion): Promise<string> {
    const result = await answerWithCodeAgent(question, {
      model: MODEL,
    });
    return result.answer;
  },
});

//#endregion

//#region Suite

describe(codeAgentStep, {
  objective: 'Answers LongMemEval questions correctly using prior chat history',
  passThreshold: 0.5,
}, () => {
  it.each(questions, async (ctx) => {
    const question = ctx.example;
    const exec = await ctx.execute(question);
    await exec.score([
      scorer.custom('longmem-correct', {
        generateScore: async (execution) => {
          const verdict = await judgeAnswer(question, String(execution.output));
          return verdict.correct ? 1 : 0;
        },
        generateReason: (_execution, score) =>
          score === 1 ? 'Judge: correct' : 'Judge: incorrect',
      }),
      scorer.answerSimilarity({
        expected: question.answer,
      }),
    ]);
  });
});

//#endregion
