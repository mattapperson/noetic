/**
 * LongMemEval-style correctness judge.
 *
 * The official benchmark grades answers with an LLM judge using question-type
 * specific rubrics (see the LongMemEval paper, ICLR 2025). This is a compact
 * faithful port: it asks a judge model whether the agent's answer matches the
 * gold answer, returning a binary correct/incorrect verdict plus a rationale.
 *
 * The judge runs through a plain Noetic `AgentHarness`, which auto-detects the
 * OpenRouter provider from `OPENROUTER_API_KEY` — no extra wiring needed.
 */

import { AgentHarness, step } from '@noetic-tools/core';
import type { LongMemQuestion } from './dataset';
import { isAbstentionQuestion } from './dataset';

//#region Types

export interface Verdict {
  readonly correct: boolean;
  readonly rationale: string;
}

export interface JudgeOptions {
  /** Judge model id. Defaults to NOETIC_JUDGE_MODEL or a strong default. */
  readonly model?: string;
}

//#endregion

//#region Prompt

function defaultJudgeModel(): string {
  return process.env.NOETIC_JUDGE_MODEL ?? 'openai/gpt-4o';
}

const JUDGE_INSTRUCTIONS = [
  'You are a strict grader for a long-term-memory question-answering benchmark.',
  'You are given a question, the gold (correct) answer, and a response to grade.',
  'Decide whether the response is correct: it must convey the same facts as the',
  'gold answer. Extra detail is fine as long as it is consistent and the key',
  'fact is present. Minor wording differences do not matter.',
  '',
  'Reply with exactly one line in the form:',
  'VERDICT: yes|no — <one short sentence of justification>',
].join('\n');

function buildJudgePrompt(question: LongMemQuestion, answer: string): string {
  const abstentionNote = isAbstentionQuestion(question)
    ? '\nNOTE: This is an abstention question. The response is CORRECT only if it ' +
      'declines to answer / states the information is not available.'
    : '';
  return [
    `QUESTION: ${question.question}`,
    `GOLD ANSWER: ${question.answer}`,
    `RESPONSE TO GRADE: ${answer}`,
    abstentionNote,
  ].join('\n');
}

function parseVerdict(raw: string): Verdict {
  const text = raw.trim();
  const match = text.match(/VERDICT:\s*(yes|no)\b\s*[—\-:]*\s*(.*)/i);
  if (match) {
    return {
      correct: match[1]?.toLowerCase() === 'yes',
      rationale: match[2]?.trim() || text,
    };
  }
  // Fallback: look for a leading yes/no anywhere.
  const correct = /\byes\b/i.test(text) && !/\bno\b/i.test(text.split(/\byes\b/i)[0] ?? '');
  return {
    correct,
    rationale: text,
  };
}

//#endregion

//#region Public API

/** Grades one agent answer against the gold answer. */
export async function judgeAnswer(
  question: LongMemQuestion,
  answer: string,
  options: JudgeOptions = {},
): Promise<Verdict> {
  const model = options.model ?? defaultJudgeModel();
  const harness = new AgentHarness({
    name: 'longmem-judge',
    params: {},
  });
  const ctx = harness.createContext();
  const judgeStep = step.llm({
    id: 'longmem-judge-call',
    model,
    instructions: JUDGE_INSTRUCTIONS,
  });
  const raw = await harness.run(judgeStep, buildJudgePrompt(question, answer), ctx);
  return parseVerdict(String(raw));
}

//#endregion
