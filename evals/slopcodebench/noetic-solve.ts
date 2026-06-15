#!/usr/bin/env bun
/**
 * Headless Noetic code-agent solver — the "agent binary" SlopCodeBench drives.
 *
 * SlopCodeBench (https://github.com/SprocketLab/slop-code-bench) is a Python
 * benchmark that hands a coding agent an evolving spec and grades the resulting
 * program with pytest. Its agents are CLIs invoked non-interactively against a
 * workspace directory. This script is exactly that: it spins up the real
 * `createCodeAgent()` harness and drives its product `codeAgentWorkflow`
 * (plan/act/verify/fix) in forced **act** mode — the headless equivalent of an
 * auto-approved plan — against a real on-disk workspace, runs one task to
 * completion, and prints a single machine-readable usage line.
 *
 * The Python adapter (`adapter.py`) shells out to this and reads that line.
 *
 * Usage:
 *   bun noetic-solve.ts --cwd <workspace> --model <openrouter-slug> \
 *       --task-file <file> [--max-steps N] [--instructions <text>]
 *
 * The task may also be supplied on stdin (used when --task-file is omitted).
 * Requires OPENROUTER_API_KEY in the environment.
 *
 * Output contract: every diagnostic goes to stderr; stdout carries exactly one
 * line beginning with the sentinel `__NOETIC_RESULT__ ` followed by JSON:
 *   { "answer", "elapsedMs", "inputTokens", "outputTokens", "cost" }
 */

import * as fs from 'node:fs';

import {
  codeAgentWorkflow,
  createCodeAgent,
  createCodingToolsPlugin,
  persistFlowState,
  writeFlowState,
} from '@noetic-tools/code-agent';
import {
  createLocalFsAdapter,
  createLocalShellAdapter,
  createLocalSubprocessAdapter,
} from '@noetic-tools/platform-node';

//#region Args

/** Sentinel that prefixes the one machine-readable stdout line. */
export const RESULT_SENTINEL = '__NOETIC_RESULT__';

interface SolveArgs {
  cwd: string;
  model: string;
  taskFile?: string;
  maxSteps?: number;
  instructions?: string;
}

function parseArgs(argv: string[]): SolveArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag?.startsWith('--') && next !== undefined) {
      flags.set(flag, next);
      i++;
    }
  }

  const cwd = flags.get('--cwd');
  const model = flags.get('--model');
  if (!cwd) {
    throw new Error('--cwd <workspace> is required');
  }
  if (!model) {
    throw new Error('--model <openrouter-slug> is required');
  }

  const maxStepsRaw = flags.get('--max-steps');
  return {
    cwd,
    model,
    taskFile: flags.get('--task-file'),
    instructions: flags.get('--instructions'),
    maxSteps: maxStepsRaw ? Math.max(1, Number.parseInt(maxStepsRaw, 10) || 1) : undefined,
  };
}

async function readTask(args: SolveArgs): Promise<string> {
  if (args.taskFile) {
    return fs.readFileSync(args.taskFile, 'utf-8');
  }
  // Fall back to stdin.
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

//#endregion

//#region Solve

const DEFAULT_INSTRUCTIONS = [
  'You are an autonomous coding agent solving a programming task in the current',
  'working directory. Implement a complete, correct solution by reading and',
  'writing files and running shell commands. The task specifies the program',
  'entry point and behavior — follow it exactly, including required exit codes',
  'and output formats. When dependencies are needed, create a `requirements.txt`.',
  'Work until the task is fully implemented; do not ask for confirmation.',
].join('\n');

async function solve(args: SolveArgs): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set.');
  }

  const task = (await readTask(args)).trim();
  if (task.length === 0) {
    throw new Error('Empty task (no --task-file content and no stdin).');
  }

  const agent = await createCodeAgent({
    name: 'scbench-noetic',
    model: args.model,
    cwd: args.cwd,
    instructions: args.instructions ?? DEFAULT_INSTRUCTIONS,
    // Curated stack: the coding tools only. The SDK default stack adds plan/
    // task/temporal layers and tools that derail an autonomous, non-interactive
    // act run (and break provider request validation).
    defaultMemory: false,
    llm: {
      provider: 'openrouter',
      apiKey,
      // Identical model calls across checkpoints aren't re-billed.
      cache: true,
    },
    // Real on-disk workspace (SlopCodeBench's local environment temp dir).
    adapters: {
      fs: createLocalFsAdapter(),
      shell: createLocalShellAdapter(),
      subprocess: createLocalSubprocessAdapter(),
    },
    // File + shell tools the act/verify/fix loop edits the workspace with.
    plugins: [
      createCodingToolsPlugin(),
    ],
  });

  try {
    // Drive the real code-agent product workflow (plan/act/verify/fix). We
    // force `act` mode on the context so the workflow skips the interactive
    // plan-approval gate and implements + verifies autonomously — the headless
    // equivalent of an auto-approved plan. The task is passed as the workflow
    // input so it reaches the (spawned) act sub-agent; token/cost usage rolls
    // up onto `ctx`.
    const ctx = agent.createContext();
    writeFlowState(ctx, {
      mode: 'act',
    });
    await persistFlowState(ctx);

    const start = performance.now();
    const output = await agent.run(codeAgentWorkflow, task, ctx);
    const elapsedMs = performance.now() - start;

    const result = {
      answer: String(output).trim(),
      elapsedMs: Math.round(elapsedMs),
      inputTokens: ctx.tokens.input,
      outputTokens: ctx.tokens.output,
      cost: ctx.cost,
    };
    process.stdout.write(`${RESULT_SENTINEL} ${JSON.stringify(result)}\n`);
  } finally {
    await agent.dispose();
  }
}

//#endregion

solve(parseArgs(process.argv.slice(2))).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`noetic-solve failed: ${message}\n`);
  process.exit(1);
});
