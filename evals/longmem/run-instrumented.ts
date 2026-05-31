#!/usr/bin/env bun
/**
 * Instrumented LongMemEval runner — visibility + diagnosis + best-config sweep.
 *
 * This runner answers the three things the raw `run.ts` baseline cannot:
 *
 *   1. VISIBILITY  — after every QA turn it reads `ctx.lastLayerUsage`, so you
 *      can see exactly which memory layer put what into the next call's context
 *      window (token count per layer + system/tools/history split).
 *   2. DIAGNOSIS   — every result is tagged by question type and a heuristic
 *      failure cause, and the final summary breaks accuracy down both ways.
 *   3. BEST CONFIG — it stacks the levers FINDINGS.md proved out:
 *        • `temporalMemory` (the shipped core layer) grounded to the question's
 *          own date, so relative-time reasoning anchors correctly.
 *        • a recall-time distillation layer that map/reduces the haystack into a
 *          compact `<known_facts>` ledger (the "less is more" counting lever).
 *        • an enumerate-then-count answerer prompt (count = list length).
 *
 * Results stream to a crash-safe JSONL file so a long run survives interruption.
 *
 * Usage:
 *   bun evals/longmem/run-instrumented.ts                      # full 500
 *   bun evals/longmem/run-instrumented.ts --limit 20           # first 20
 *   bun evals/longmem/run-instrumented.ts --type temporal-reasoning
 *   bun evals/longmem/run-instrumented.ts --concurrency 4 --out /tmp/run.jsonl
 *
 * Requires OPENROUTER_API_KEY.
 */

import * as fs from 'node:fs';
import { createCodeAgent } from '@noetic-tools/code-agent';
import type { MemoryLayer } from '@noetic-tools/core';
import { AgentHarness, createMessage, step, temporalMemory } from '@noetic-tools/core';
import type { LongMemQuestion, LongMemQuestionType } from './dataset';
import {
  buildQuestionPrompt,
  isAbstentionQuestion,
  isLongMemQuestionType,
  loadLongMemEval,
} from './dataset';
import { judgeAnswer } from './judge';

//#region Args

interface RunArgs {
  limit?: number;
  type?: LongMemQuestionType;
  model: string;
  judgeModel?: string;
  concurrency: number;
  out: string;
}

function parseArgs(argv: string[]): RunArgs {
  const args: RunArgs = {
    model: process.env.LONGMEM_MODEL ?? '~anthropic/claude-sonnet-latest',
    concurrency: 3,
    out: '/tmp/longmem-instrumented.jsonl',
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--limit' && next) {
      args.limit = Math.max(1, Number.parseInt(next, 10) || 1);
      i++;
    } else if (flag === '--model' && next) {
      args.model = next;
      i++;
    } else if (flag === '--judge-model' && next) {
      args.judgeModel = next;
      i++;
    } else if (flag === '--concurrency' && next) {
      args.concurrency = Math.max(1, Number.parseInt(next, 10) || 1);
      i++;
    } else if (flag === '--out' && next) {
      args.out = next;
      i++;
    } else if (flag === '--type' && next && isLongMemQuestionType(next)) {
      args.type = next;
      i++;
    }
  }
  return args;
}

//#endregion

//#region Distillation layer (recall-time map/reduce)

const EXTRACT_INSTRUCTIONS = [
  'You are a memory distiller. Convert the conversation transcript below into a',
  'compact, atomic fact ledger the assistant can later use to answer questions.',
  '',
  'Rules:',
  '- Extract every concrete, countable fact (events, items, dates, preferences).',
  '- Group related facts under short headers.',
  '- Keep each fact on its own line, prefixed with "- ".',
  '- Preserve the session date next to every time-sensitive fact.',
  '- Do NOT merge distinct instances — two separate purchases stay two lines.',
  '- When a fact changes over time, keep BOTH with their dates (do not collapse).',
  '- Omit chit-chat, greetings, and meta-conversation.',
].join('\n');

/**
 * Recall-time distillation: extract the seeded transcript into a fact ledger
 * once (memoized on state), then inject it as a `<known_facts>` block.
 */
function distillationMemory(opts: { model: string; transcript: string }): MemoryLayer<{
  ledger: string | null;
}> {
  return {
    id: 'distillation',
    name: 'Distillation Memory',
    slot: 250,
    scope: 'execution',
    hooks: {
      async init() {
        return {
          state: {
            ledger: null,
          },
        };
      },
      async recall({ state }) {
        if (state.ledger === null) {
          state.ledger = await distill(opts.transcript, opts.model);
        }
        const text = `<known_facts>\n${state.ledger}\n</known_facts>`;
        return {
          items: [
            createMessage(text, 'developer'),
          ],
          tokenCount: Math.ceil(text.length / 4),
        };
      },
    },
  };
}

/** One-shot extraction on a throwaway harness (auto-detects OPENROUTER_API_KEY). */
async function distill(transcript: string, model: string): Promise<string> {
  const harness = new AgentHarness({
    name: 'longmem-distiller',
    params: {},
  });
  const ctx = harness.createContext();
  const distillStep = step.llm({
    id: 'distill',
    model,
    instructions: EXTRACT_INSTRUCTIONS,
  });
  const out = String(await harness.run(distillStep, transcript, ctx)).trim();
  return out || transcript;
}

//#endregion

//#region Answerer

const QA_INSTRUCTIONS = [
  'You are a helpful assistant with long-term memory of your prior conversations',
  'with the user. You are given (a) a distilled ledger of known facts, (b) the',
  'current date, and (c) the full conversation history. Use the ledger first for',
  'counting and dates; fall back to the conversation for exact wording and',
  'preferences.',
  '',
  'For "how many / how often" questions, FIRST list every matching instance as a',
  'numbered list (quoting its supporting fact), THEN report the count as the list',
  'length. For temporal questions, use the current date and session timestamps to',
  'do the date arithmetic explicitly before answering.',
  'If the history lacks the information, or the question assumes a fact not present,',
  'say plainly that you do not have that information. Answer concisely.',
].join('\n');

//#endregion

//#region Per-question execution

interface QuestionRecord {
  index: number;
  questionId: string;
  type: LongMemQuestionType;
  question: string;
  gold: string;
  answer: string;
  correct: boolean;
  rationale: string;
  failureCause: string | null;
  cost: number;
  layerUsage: LayerUsageSummary | null;
}

interface LayerUsageSummary {
  layers: {
    layerId: string;
    tokenCount: number;
  }[];
  systemPromptTokens: number;
  toolsTokens: number;
  historyTokens: number;
  totalUsedTokens: number;
}

/** Structural shape of `ctx.lastLayerUsage` (read defensively from `unknown`). */
interface RawLayerUsage {
  layers: {
    layerId: string;
    tokenCount: number;
  }[];
  systemPromptTokens: number;
  toolsTokens: number;
  historyTokens: number;
  totalUsedTokens: number;
}

function isRawLayerUsage(value: unknown): value is RawLayerUsage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'layers' in value &&
    Array.isArray(value.layers) &&
    'totalUsedTokens' in value &&
    typeof value.totalUsedTokens === 'number'
  );
}

function summarizeUsage(usage: unknown): LayerUsageSummary | null {
  if (!isRawLayerUsage(usage)) {
    return null;
  }
  return {
    layers: usage.layers.map((l) => ({
      layerId: l.layerId,
      tokenCount: l.tokenCount,
    })),
    systemPromptTokens: usage.systemPromptTokens,
    toolsTokens: usage.toolsTokens,
    historyTokens: usage.historyTokens,
    totalUsedTokens: usage.totalUsedTokens,
  };
}

/** Heuristic failure-cause tagging for the diagnosis summary (failures only). */
function classifyFailure(q: LongMemQuestion): string {
  if (isAbstentionQuestion(q)) {
    return 'abstention';
  }
  if (/how many|how much|how often|number of|count|times/i.test(q.question)) {
    return 'counting/coverage';
  }
  if (q.question_type === 'temporal-reasoning') {
    return 'temporal arithmetic/ordering';
  }
  if (q.question_type === 'knowledge-update') {
    return 'knowledge-update (stale vs latest)';
  }
  return 'fact-recall';
}

async function runQuestion(
  q: LongMemQuestion,
  index: number,
  args: RunArgs,
): Promise<QuestionRecord> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set.');
  }
  const transcript = buildQuestionPrompt(q);
  const questionDate = new Date(q.question_date);
  const agent = await createCodeAgent({
    name: 'longmem-instrumented',
    model: args.model,
    cwd: '/longmem',
    defaultMemory: false,
    llm: {
      provider: 'openrouter',
      apiKey,
      cache: true,
    },
    memory: [
      temporalMemory({
        now: () => questionDate,
        groundDateTime: true,
        scope: 'execution',
      }),
      distillationMemory({
        model: args.model,
        transcript,
      }),
    ],
  });
  const qaStep = step.llm({
    id: 'longmem-instrumented-qa',
    model: args.model,
    instructions: QA_INSTRUCTIONS,
  });

  try {
    const ctx = agent.createContext();
    const output = await agent.run(qaStep, transcript, ctx);
    const answer = String(output).trim();
    const verdict = await judgeAnswer(q, answer, {
      model: args.judgeModel,
    });
    // `lastLayerUsage` is recorded on the context post-call but isn't on the
    // public Context type; read it via `in`-narrowing (no cast) as `unknown`.
    const rawUsage = 'lastLayerUsage' in ctx ? ctx.lastLayerUsage : undefined;
    return {
      index,
      questionId: q.question_id,
      type: q.question_type,
      question: q.question,
      gold: q.answer,
      answer,
      correct: verdict.correct,
      rationale: verdict.rationale,
      failureCause: verdict.correct ? null : classifyFailure(q),
      cost: ctx.cost,
      layerUsage: summarizeUsage(rawUsage),
    };
  } finally {
    await agent.dispose();
  }
}

//#endregion

//#region Concurrency + reporting

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      const item = items[i];
      if (item === undefined) {
        continue;
      }
      results[i] = await fn(item, i);
    }
  }
  const workers = Array.from(
    {
      length: Math.min(limit, items.length),
    },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

function printSummary(records: QuestionRecord[]): void {
  const graded = records.filter((r) => r.answer !== '__error__');
  const correct = graded.filter((r) => r.correct).length;
  const accuracy = graded.length > 0 ? ((correct / graded.length) * 100).toFixed(1) : 'n/a';
  const totalCost = records.reduce((s, r) => s + r.cost, 0);

  console.log(`\n${'─'.repeat(64)}`);
  console.log(
    `OVERALL: ${correct}/${graded.length} (${accuracy}%) · total cost $${totalCost.toFixed(4)}`,
  );

  console.log('\nBy question type:');
  const types = [
    ...new Set(records.map((r) => r.type)),
  ].sort();
  for (const t of types) {
    const sub = graded.filter((r) => r.type === t);
    const ok = sub.filter((r) => r.correct).length;
    console.log(`  ${t.padEnd(28)} ${ok}/${sub.length}`);
  }

  console.log('\nFailure causes:');
  const causes = new Map<string, number>();
  for (const r of graded.filter((r) => !r.correct)) {
    causes.set(r.failureCause ?? 'unknown', (causes.get(r.failureCause ?? 'unknown') ?? 0) + 1);
  }
  for (const [cause, n] of [
    ...causes.entries(),
  ].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cause.padEnd(34)} ${n}`);
  }

  // Per-layer context-window visibility (averaged over graded questions).
  console.log('\nPer-layer context contribution (avg tokens/question):');
  const layerTotals = new Map<string, number>();
  let withUsage = 0;
  for (const r of graded) {
    if (!r.layerUsage) {
      continue;
    }
    withUsage++;
    for (const l of r.layerUsage.layers) {
      layerTotals.set(l.layerId, (layerTotals.get(l.layerId) ?? 0) + l.tokenCount);
    }
  }
  if (withUsage === 0) {
    console.log('  (no lastLayerUsage captured — memory layers contributed nothing)');
  } else {
    for (const [id, total] of [
      ...layerTotals.entries(),
    ].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${id.padEnd(28)} ${Math.round(total / withUsage)}`);
    }
  }
}

//#endregion

//#region Main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const questions = loadLongMemEval({
    limit: args.limit,
    type: args.type,
  });
  if (questions.length === 0) {
    console.error('No questions matched the given filters.');
    process.exit(1);
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY is not set — export it (or run via `! …`) before launching.');
    process.exit(1);
  }

  console.log(
    `Instrumented run on ${questions.length} question(s)\n` +
      `  agent model: ${args.model}\n` +
      `  judge model: ${args.judgeModel ?? process.env.NOETIC_JUDGE_MODEL ?? 'openai/gpt-4o'}\n` +
      `  concurrency: ${args.concurrency} · out: ${args.out}\n`,
  );

  fs.writeFileSync(args.out, '');
  let done = 0;
  const records = await mapWithConcurrency(questions, args.concurrency, async (q, i) => {
    let record: QuestionRecord;
    try {
      record = await runQuestion(q, i, args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record = {
        index: i,
        questionId: q.question_id,
        type: q.question_type,
        question: q.question,
        gold: q.answer,
        answer: '__error__',
        correct: false,
        rationale: message.slice(0, 200),
        failureCause: 'error',
        cost: 0,
        layerUsage: null,
      };
    }
    fs.appendFileSync(args.out, `${JSON.stringify(record)}\n`);
    done++;
    const mark = record.answer === '__error__' ? '⚠️' : record.correct ? '✅' : '❌';
    console.log(
      `[${done}/${questions.length}] ${mark} (${record.type}) ${record.question.slice(0, 70)}`,
    );
    return record;
  });

  printSummary(records);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

//#endregion
