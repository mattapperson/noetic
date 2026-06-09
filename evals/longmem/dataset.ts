/**
 * LongMemEval dataset loader + transcript formatting.
 *
 * LongMemEval (ICLR 2025) benchmarks chat assistants on long-term interactive
 * memory. Each question ships with a "haystack" of prior chat sessions; the
 * assistant must answer using evidence buried in that history.
 *
 * The `oracle` variant is the smallest official split — it contains only the
 * evidence sessions for each question (no distractor sessions), so it is the
 * cheapest dataset to run a real agent against end-to-end.
 *
 * Source: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
 * Schema: https://github.com/xiaowu0162/LongMemEval
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { z } from 'zod';

//#region Schema

/** A single turn in a chat session. `has_answer` flags evidence turns (oracle). */
const TurnSchema = z.object({
  role: z.enum([
    'user',
    'assistant',
  ]),
  content: z.string(),
  has_answer: z.boolean().optional(),
});

/** One LongMemEval question with its haystack of prior chat sessions. */
const LongMemQuestionSchema = z.object({
  question_id: z.string(),
  question_type: z.enum([
    'single-session-user',
    'single-session-assistant',
    'single-session-preference',
    'temporal-reasoning',
    'knowledge-update',
    'multi-session',
  ]),
  question: z.string(),
  // Some oracle answers are bare numbers (e.g. a year or a count); normalize
  // them all to strings so downstream prompting/grading is uniform.
  answer: z
    .union([
      z.string(),
      z.number(),
    ])
    .transform(String),
  question_date: z.string(),
  haystack_dates: z.array(z.string()),
  haystack_session_ids: z.array(z.string()),
  haystack_sessions: z.array(z.array(TurnSchema)),
  answer_session_ids: z.array(z.string()),
});

const LongMemDatasetSchema = z.array(LongMemQuestionSchema);

export type LongMemTurn = z.infer<typeof TurnSchema>;
export type LongMemQuestion = z.infer<typeof LongMemQuestionSchema>;
export type LongMemQuestionType = LongMemQuestion['question_type'];

export const QUESTION_TYPES = LongMemQuestionSchema.shape.question_type.options;

// Typed as ReadonlySet<string> so the guard can test arbitrary input without a
// cast; membership still proves the value is a LongMemQuestionType.
const questionTypeSet: ReadonlySet<string> = new Set(QUESTION_TYPES);

/** Narrows an arbitrary string to a valid LongMemEval question type. */
export function isLongMemQuestionType(value: string): value is LongMemQuestionType {
  return questionTypeSet.has(value);
}

//#endregion

//#region Loading

/** Default location the download script writes the oracle split to. */
export const DEFAULT_ORACLE_PATH = path.join(import.meta.dir, 'data', 'longmemeval_oracle.json');

export interface LoadOptions {
  /** Path to the dataset JSON. Defaults to the bundled oracle location. */
  readonly file?: string;
  /** Cap the number of questions returned (the "smallest dataset" slice). */
  readonly limit?: number;
  /** Only include questions of this type. */
  readonly type?: LongMemQuestionType;
}

/**
 * Loads and validates a LongMemEval split. Throws a clear, actionable error if
 * the file is missing so the runner can point the user at the download script.
 */
export function loadLongMemEval(options: LoadOptions = {}): LongMemQuestion[] {
  const file = options.file ?? DEFAULT_ORACLE_PATH;
  if (!fs.existsSync(file)) {
    throw new Error(
      `LongMemEval dataset not found at ${file}.\n` +
        'Download the smallest (oracle) split first:\n' +
        '  bun evals/longmem/download.ts',
    );
  }

  const all = LongMemDatasetSchema.parse(JSON.parse(fs.readFileSync(file, 'utf-8')));

  const filtered = options.type ? all.filter((q) => q.question_type === options.type) : all;
  const limit = options.limit ?? filtered.length;
  return filtered.slice(0, Math.max(0, limit));
}

//#endregion

//#region Transcript Formatting

/**
 * Renders a question's haystack sessions into a single chronological transcript.
 * Each session is headed with its timestamp so the agent can reason about
 * temporal questions ("the first issue after my first service").
 */
export function formatHaystackTranscript(question: LongMemQuestion): string {
  const blocks: string[] = [];
  for (const [i, session] of question.haystack_sessions.entries()) {
    const date = question.haystack_dates[i] ?? 'unknown date';
    const lines = session.map((turn) => {
      const speaker = turn.role === 'user' ? 'User' : 'Assistant';
      return `${speaker}: ${turn.content}`;
    });
    blocks.push(`--- Session ${i + 1} (${date}) ---\n${lines.join('\n')}`);
  }
  return blocks.join('\n\n');
}

/**
 * Builds the full prompt sent to the agent: the prior conversation history
 * followed by the current question and its date. This is the LongMemEval
 * "full-context" setup — all evidence is available; the agent must locate and
 * synthesize the relevant facts.
 */
export function buildQuestionPrompt(question: LongMemQuestion): string {
  const transcript = formatHaystackTranscript(question);
  return [
    'Below is the prior conversation history between the user and the assistant,',
    'organized into timestamped sessions.',
    '',
    transcript,
    '',
    `--- Current question (asked on ${question.question_date}) ---`,
    question.question,
  ].join('\n');
}

/** Abstention questions (id ends with `_abs`) expect "I don't know"-style answers. */
export function isAbstentionQuestion(question: LongMemQuestion): boolean {
  return question.question_id.endsWith('_abs');
}

//#endregion
