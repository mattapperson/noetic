#!/usr/bin/env bun
/**
 * Standalone LongMemEval runner for the Noetic code agent.
 *
 * Runs the real `createCodeAgent()` harness against the smallest (oracle) split
 * and grades each answer with a LongMemEval-style judge. This is the simplest
 * way to prove the code agent runs end-to-end on the benchmark.
 *
 * Usage:
 *   bun evals/longmem/run.ts                       # 1 question (smallest run)
 *   bun evals/longmem/run.ts --limit 5             # first 5 questions
 *   bun evals/longmem/run.ts --type temporal-reasoning --limit 3
 *   bun evals/longmem/run.ts --model ~anthropic/claude-sonnet-latest
 *
 * Requires OPENROUTER_API_KEY in the environment.
 */

import { answerWithCodeAgent } from './agent';
import type { LongMemQuestionType } from './dataset';
import { isLongMemQuestionType, loadLongMemEval } from './dataset';
import { judgeAnswer } from './judge';

//#region Args

interface RunArgs {
  limit: number;
  model: string;
  judgeModel?: string;
  type?: LongMemQuestionType;
  file?: string;
}

function parseArgs(argv: string[]): RunArgs {
  const args: RunArgs = {
    limit: 1,
    model: process.env.LONGMEM_MODEL ?? '~anthropic/claude-sonnet-latest',
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
    } else if (flag === '--file' && next) {
      args.file = next;
      i++;
    } else if (flag === '--type' && next && isLongMemQuestionType(next)) {
      args.type = next;
      i++;
    }
  }
  return args;
}

//#endregion

//#region Run

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const questions = loadLongMemEval({
    limit: args.limit,
    type: args.type,
    file: args.file,
  });

  if (questions.length === 0) {
    console.error('No questions matched the given filters.');
    process.exit(1);
  }

  console.log(
    `Running code agent on ${questions.length} LongMemEval (oracle) question(s)\n` +
      `  agent model: ${args.model}\n` +
      `  judge model: ${args.judgeModel ?? process.env.NOETIC_JUDGE_MODEL ?? 'openai/gpt-4o'}\n`,
  );

  let correct = 0;
  let errors = 0;
  let totalCost = 0;

  for (const [i, q] of questions.entries()) {
    console.log(`[${i + 1}/${questions.length}] (${q.question_type}) ${q.question}`);
    try {
      const result = await answerWithCodeAgent(q, {
        model: args.model,
      });
      const verdict = await judgeAnswer(q, result.answer, {
        model: args.judgeModel,
      });
      totalCost += result.cost;
      if (verdict.correct) {
        correct++;
      }

      console.log(`  gold:   ${q.answer}`);
      console.log(`  agent:  ${result.answer.replace(/\n/g, ' ')}`);
      console.log(
        `  graded: ${verdict.correct ? '✅ correct' : '❌ incorrect'} — ${verdict.rationale}`,
      );
      console.log(
        `  usage:  ${Math.round(result.elapsedMs)}ms · ` +
          `${result.inputTokens}+${result.outputTokens} tok · $${result.cost.toFixed(4)}\n`,
      );
    } catch (err) {
      // One bad question (e.g. a provider request-validation error) must not
      // abort the whole run — record it as an error and keep going.
      errors++;
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  graded: ⚠️ error — ${message.replace(/\n/g, ' ').slice(0, 200)}\n`);
    }
  }

  const graded = questions.length - errors;
  const accuracy = graded > 0 ? ((correct / graded) * 100).toFixed(1) : 'n/a';
  console.log('─'.repeat(60));
  console.log(
    `Accuracy: ${correct}/${graded} (${accuracy}%)` +
      `${errors > 0 ? ` · ${errors} error(s) excluded` : ''}` +
      ` · total cost $${totalCost.toFixed(4)}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

//#endregion
