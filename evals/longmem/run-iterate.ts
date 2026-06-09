#!/usr/bin/env bun
/**
 * Memory-layer iteration harness — measures fact-recovery on a failing subset.
 *
 * Iterates the distillation memory layer against the questions a prior run got
 * wrong (`/tmp/fail_ids.json`). Every question here was a FAILURE at baseline,
 * so "correct" == "recovered". This is the cheap inner loop FINDINGS.md uses:
 * tune the layer, re-run the ~30 failures, watch recovery climb, before paying
 * for a full-500 validation.
 *
 * The round-6 distiller is QUERY-AWARE: it map/reduces the haystack into a note
 * shaped for THIS question — an exhaustive enumerated instance list for counting,
 * current-value supersession for knowledge-update, a dated timeline for temporal
 * arithmetic, and an explicit "NOT MENTIONED" for false-premise/abstention. The
 * full ledger it injects is captured per question for visibility.
 *
 * Usage:
 *   bun evals/longmem/run-iterate.ts                      # all failing ids
 *   bun evals/longmem/run-iterate.ts --ids /tmp/x.json --concurrency 6
 *   bun evals/longmem/run-iterate.ts --cause counting/coverage
 */

import * as fs from 'node:fs';
import { createCodeAgent } from '@noetic-tools/code-agent';
import type { MemoryLayer } from '@noetic-tools/core';
import { AgentHarness, Slot, step, temporalMemory } from '@noetic-tools/core';
import type { LongMemQuestion } from './dataset';
import { buildQuestionPrompt, loadLongMemEval } from './dataset';
import { judgeAnswer } from './judge';

//#region Args

interface RunArgs {
  idsFile: string;
  model: string;
  judgeModel?: string;
  concurrency: number;
  out: string;
}

function parseArgs(argv: string[]): RunArgs {
  const args: RunArgs = {
    idsFile: '/tmp/fail_ids.json',
    model: process.env.LONGMEM_MODEL ?? '~anthropic/claude-sonnet-latest',
    concurrency: 5,
    out: '/tmp/longmem-iterate.jsonl',
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--ids' && next) {
      args.idsFile = next;
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
    }
  }
  return args;
}

//#endregion

//#region Round-6 query-aware distiller

const EXTRACT_INSTRUCTIONS = [
  'You are a memory distiller. You are given a QUESTION and a conversation',
  'TRANSCRIPT. Produce a compact note that contains EXACTLY the facts needed to',
  'answer the question — less is more, but never drop a countable or dated detail.',
  '',
  'Emit only the sections that apply, in this order:',
  '',
  'RELEVANT FACTS:',
  '- atomic facts that bear on the question, each with the session date.',
  '',
  'MATCHING INSTANCES:  (only if the question asks "how many / how often / number of")',
  '- Scan the ENTIRE transcript top to bottom. List every DISTINCT real-world',
  '  instance that matches, one numbered line each with its date — include instances',
  '  mentioned only in passing or implied by a follow-up ("my second visit", "again',
  '  last week"). Under-counting by missing an instance is the worst error. Never',
  '  merge two distinct instances; never list the same instance twice. End with',
  '  "COUNT: <n>" = the number of lines.',
  '',
  'CURRENT VALUES:  (only if an attribute CHANGED over time)',
  '- "<attribute>: <latest value> (current as of <date>; was <old value> on <date>)".',
  '',
  'TIMELINE:  (only if the question needs date arithmetic or ordering)',
  '- "<YYYY-MM-DD>: <event>" lines in chronological order.',
  '',
  'NOT MENTIONED:  (only if the question names a person/place/thing/event that the',
  'transcript never actually mentions)',
  '- "<the unmentioned entity>".',
  '',
  'Record only what is actually stated. Do not infer or invent.',
].join('\n');

async function distill(question: string, transcript: string, model: string): Promise<string> {
  const harness = new AgentHarness({
    name: 'iterate-distiller',
    params: {},
  });
  const ctx = harness.createContext();
  const distillStep = step.llm({
    id: 'distill',
    model,
    instructions: EXTRACT_INSTRUCTIONS,
  });
  const input = `QUESTION:\n${question}\n\nTRANSCRIPT:\n${transcript}`;
  const out = String(await harness.run(distillStep, input, ctx)).trim();
  return out || transcript;
}

/** Injects a pre-computed query-aware note as a `<memory_note>` block. */
function noteLayer(note: string): MemoryLayer<null> {
  const text = `<memory_note>\n${note}\n</memory_note>`;
  return {
    id: 'distillation',
    name: 'Query-Aware Distillation',
    slot: Slot.ENTITY,
    scope: 'execution',
    hooks: {
      async recall() {
        return {
          items: [
            {
              id: 'note',
              type: 'message',
              role: 'user',
              status: 'completed',
              content: [
                {
                  type: 'input_text',
                  text,
                },
              ],
            },
          ],
          tokenCount: Math.ceil(text.length / 4),
        };
      },
    },
  };
}

//#endregion

//#region Round-6 answerer

const QA_INSTRUCTIONS = [
  'Answer the user question. The FULL conversation history is the authoritative',
  'source of truth; the <memory_note> is only a distilled index/aid to help you',
  'find and count facts. If the note and the conversation ever conflict, or the',
  'note is missing something, TRUST THE CONVERSATION.',
  '',
  '- "How many / how often" questions: the MATCHING INSTANCES list is a starting',
  '  point but MAY be incomplete. Before answering, re-scan the FULL conversation',
  '  history for any additional matching instance not already in the list, add it,',
  '  then report the count of the combined de-duplicated set. Missing a real',
  '  instance is the most common error — check the raw history, do not just trust',
  '  the COUNT line.',
  '- "What is X now / current" questions: use CURRENT VALUES (the latest value).',
  '- Date-difference or ordering questions: use TIMELINE and the current date and',
  '  show the arithmetic before answering.',
  '- Only reply "not enough information" if BOTH the note AND the full conversation',
  '  genuinely lack it (e.g. the question names a person/event that never appears).',
  '  Never refuse a counting question — scan the conversation and count. But do not',
  '  guess an answer from a similar-but-different fact when the real one is absent.',
  '',
  'Answer concisely — the final answer only, no preamble.',
].join('\n');

//#endregion

//#region Execution

interface IterRecord {
  questionId: string;
  type: string;
  question: string;
  gold: string;
  answer: string;
  recovered: boolean;
  rationale: string;
  cost: number;
  noteChars: number;
  transcriptChars: number;
  notePreview: string;
}

async function runOne(q: LongMemQuestion, args: RunArgs): Promise<IterRecord> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set.');
  }
  const transcript = buildQuestionPrompt(q);
  const note = await distill(q.question, transcript, args.model);
  const questionDate = new Date(q.question_date);
  const agent = await createCodeAgent({
    name: 'longmem-iterate',
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
      noteLayer(note),
    ],
  });
  const qaStep = step.llm({
    id: 'iterate-qa',
    model: args.model,
    instructions: QA_INSTRUCTIONS,
  });
  try {
    const ctx = agent.createContext();
    const answer = String(await agent.run(qaStep, transcript, ctx)).trim();
    const verdict = await judgeAnswer(q, answer, {
      model: args.judgeModel,
    });
    return {
      questionId: q.question_id,
      type: q.question_type,
      question: q.question,
      gold: q.answer,
      answer,
      recovered: verdict.correct,
      rationale: verdict.rationale,
      cost: ctx.cost,
      noteChars: note.length,
      transcriptChars: transcript.length,
      notePreview: note.slice(0, 500),
    };
  } finally {
    await agent.dispose();
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
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
      results[i] = await fn(item);
    }
  }
  await Promise.all(
    Array.from(
      {
        length: Math.min(limit, items.length),
      },
      () => worker(),
    ),
  );
  return results;
}

//#endregion

//#region Main

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY is not set.');
    process.exit(1);
  }
  const ids: string[] = JSON.parse(fs.readFileSync(args.idsFile, 'utf-8'));
  const idSet = new Set(ids);
  const all = loadLongMemEval({});
  const targets = all.filter((q) => idSet.has(q.question_id));
  if (targets.length === 0) {
    console.error('No questions matched the failing-id list.');
    process.exit(1);
  }

  console.log(
    `Iterating on ${targets.length} previously-failing question(s) · model ${args.model} · cache on\n`,
  );
  fs.writeFileSync(args.out, '');
  let done = 0;
  const records = await mapWithConcurrency(targets, args.concurrency, async (q) => {
    let rec: IterRecord;
    try {
      rec = await runOne(q, args);
    } catch (err) {
      rec = {
        questionId: q.question_id,
        type: q.question_type,
        question: q.question,
        gold: q.answer,
        answer: '__error__',
        recovered: false,
        rationale: err instanceof Error ? err.message.slice(0, 160) : String(err),
        cost: 0,
        noteChars: 0,
        transcriptChars: 0,
        notePreview: '',
      };
    }
    fs.appendFileSync(args.out, `${JSON.stringify(rec)}\n`);
    done++;
    console.log(
      `[${done}/${targets.length}] ${rec.recovered ? '✅ recovered' : '❌ still wrong'} (${rec.type}) ${rec.question.slice(0, 56)}`,
    );
    return rec;
  });

  const graded = records.filter((r) => r.answer !== '__error__');
  const recovered = graded.filter((r) => r.recovered).length;
  const avgTr = Math.round(graded.reduce((s, r) => s + r.transcriptChars, 0) / graded.length);
  const avgNote = Math.round(graded.reduce((s, r) => s + r.noteChars, 0) / graded.length);
  console.log(`\n${'─'.repeat(60)}`);
  console.log(
    `RECOVERED ${recovered}/${graded.length} previously-failing (cost $${records.reduce((s, r) => s + r.cost, 0).toFixed(2)})`,
  );
  console.log(
    `Distillation: avg transcript ${avgTr} → note ${avgNote} chars (${avgTr ? ((100 * avgNote) / avgTr).toFixed(0) : 'n/a'}%)`,
  );
  const stillByType = new Map<string, number>();
  for (const r of graded.filter((r) => !r.recovered)) {
    stillByType.set(r.type, (stillByType.get(r.type) ?? 0) + 1);
  }
  console.log(
    `Still failing by type: ${
      [
        ...stillByType.entries(),
      ]
        .map(([k, v]) => `${k}:${v}`)
        .join('  ') || 'none'
    }`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

//#endregion
