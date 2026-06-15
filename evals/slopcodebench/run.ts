#!/usr/bin/env bun
/**
 * Standalone SlopCodeBench runner for the Noetic code agent.
 *
 * Drives the real benchmark end-to-end: it invokes the unmodified `slop-code`
 * CLI (via `launch.py`, which registers the `noetic` agent) against a bundled
 * problem using the **local** execution environment, then reads the benchmark's
 * own evaluation output and prints a compact pass/fail summary.
 *
 * Pipeline per checkpoint: SlopCodeBench renders the spec → `NoeticAgent.run`
 * shells out to `noetic-solve.ts` → the real `createCodeAgent()` harness edits
 * the workspace → SlopCodeBench grades the program with pytest.
 *
 * Usage:
 *   bun evals/slopcodebench/run.ts                          # calculator, grok-code-fast-1
 *   bun evals/slopcodebench/run.ts --problem yaml_joiner
 *   bun evals/slopcodebench/run.ts --model openrouter/glm-4.6
 *   bun evals/slopcodebench/run.ts --problem calculator --prompt plan_first
 *
 * Requires OPENROUTER_API_KEY. Run `bun evals/slopcodebench/setup.ts` first
 * (this script auto-runs it if the vendor clone is missing).
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

//#region Args

interface RunArgs {
  problem: string;
  model: string;
  prompt: string;
  environment: string;
}

function parseArgs(argv: string[]): RunArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag?.startsWith('--') && next !== undefined) {
      flags.set(flag, next);
      i++;
    }
  }
  return {
    problem: flags.get('--problem') ?? 'greeter',
    model: flags.get('--model') ?? 'openrouter/claude-3.5-haiku',
    prompt: flags.get('--prompt') ?? 'just-solve',
    environment: flags.get('--environment') ?? 'local-py',
  };
}

//#endregion

//#region Paths

const HERE = import.meta.dir;
const VENDOR_DIR = path.join(HERE, 'vendor');
const PROBLEMS_DIR = path.join(HERE, 'problems-local');
const LAUNCHER = path.join(HERE, 'launch.py');
const AGENT_CONFIG = path.join(HERE, 'configs', 'noetic.yaml');
const OUTPUTS_DIR = path.join(VENDOR_DIR, 'outputs');

function ensureSetup(): void {
  if (fs.existsSync(path.join(VENDOR_DIR, '.git'))) {
    return;
  }
  console.log('Vendor clone missing — running setup first…\n');
  execFileSync(
    'bun',
    [
      path.join(HERE, 'setup.ts'),
    ],
    {
      stdio: 'inherit',
    },
  );
}

//#endregion

//#region Run

function runBenchmark(args: RunArgs): void {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set.');
  }

  const cmd = [
    'run',
    'python',
    LAUNCHER,
    'run',
    '--agent',
    AGENT_CONFIG,
    '--environment',
    args.environment,
    '--prompt',
    args.prompt,
    '--model',
    args.model,
    '--problem',
    args.problem,
    '--no-live-progress',
  ];

  console.log(
    `Running SlopCodeBench on '${args.problem}'\n` +
      '  agent:       noetic (createCodeAgent, act mode)\n' +
      `  model:       ${args.model}\n` +
      `  environment: ${args.environment}\n` +
      `  prompt:      ${args.prompt}\n`,
  );
  console.log(`  $ uv ${cmd.join(' ')}\n`);

  execFileSync('uv', cmd, {
    cwd: VENDOR_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Point the problem catalog at the wired bundled examples.
      SCBENCH_PROBLEMS_PATH: PROBLEMS_DIR,
    },
  });
}

//#endregion

//#region Summary

interface CheckpointReport {
  problem?: string;
  checkpoint?: string;
  passed_tests?: number;
  total_tests?: number;
  strict_pass_rate?: number;
  [key: string]: unknown;
}

function findLatestRunDir(): string | null {
  if (!fs.existsSync(OUTPUTS_DIR)) {
    return null;
  }
  const candidates: {
    dir: string;
    mtime: number;
  }[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, 'checkpoint_results.jsonl'))) {
        candidates.push({
          dir: full,
          mtime: fs.statSync(full).mtimeMs,
        });
        continue;
      }
      walk(full);
    }
  };
  walk(OUTPUTS_DIR);
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.dir ?? null;
}

function summarize(): void {
  const runDir = findLatestRunDir();
  if (!runDir) {
    console.log('\nNo run output found to summarize.');
    return;
  }

  const resultsFile = path.join(runDir, 'checkpoint_results.jsonl');
  const reports: CheckpointReport[] = fs
    .readFileSync(resultsFile, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Run directory: ${runDir}`);
  console.log('Checkpoint results:');
  let totalPassed = 0;
  let totalTests = 0;
  for (const report of reports) {
    const passed = report.passed_tests ?? 0;
    const total = report.total_tests ?? 0;
    totalPassed += passed;
    totalTests += total;
    const label = `${report.problem ?? '?'} / ${report.checkpoint ?? '?'}`;
    console.log(`  ${label}: ${passed}/${total} tests passed`);
  }
  const pct = totalTests > 0 ? ((totalPassed / totalTests) * 100).toFixed(1) : 'n/a';
  console.log(`Total: ${totalPassed}/${totalTests} (${pct}%)`);
  console.log(`Full summary: ${path.join(runDir, 'result.json')}`);
}

//#endregion

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  ensureSetup();
  runBenchmark(args);
  summarize();
}

main();
