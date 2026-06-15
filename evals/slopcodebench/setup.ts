#!/usr/bin/env bun
/**
 * One-time setup for the SlopCodeBench eval.
 *
 * Clones SprocketLab/slop-code-bench into `vendor/` (git-ignored) at a pinned
 * commit, installs its Python deps with `uv sync`, installs our model-catalog
 * entries into the vendored catalog, and wires our own self-contained smoke
 * problems (under `problems/`) into a flat `problems-local/` directory so
 * `--problem greeter` works offline.
 *
 * We ship our own problems rather than the benchmark repo's bundled `examples/`
 * because those examples are illustrative tutorials whose specs omit the entry-
 * file placeholder and whose configs have drifted from the pinned schema. The
 * full official problem set (gabeorlanski/scb-problems) is large and fetched
 * separately via `slop-code sync`; point `SCBENCH_PROBLEMS_PATH` at it to run
 * the real benchmark.
 *
 * Prerequisites on PATH: `git`, `uv` (https://astral.sh/uv), and `bun`.
 *
 * Usage:
 *   bun evals/slopcodebench/setup.ts            # clone + uv sync + wire problems
 *   SCBENCH_REF=<sha> bun evals/slopcodebench/setup.ts   # pin a different ref
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_URL = 'https://github.com/SprocketLab/slop-code-bench.git';
// Pinned for reproducibility; override with SCBENCH_REF.
const DEFAULT_REF = '13de1a7a6b8b3dc5cc532a0c322a0997afa5bec7';

const HERE = import.meta.dir;
const VENDOR_DIR = path.join(HERE, 'vendor');
const PROBLEMS_SRC_DIR = path.join(HERE, 'problems');
const PROBLEMS_DIR = path.join(HERE, 'problems-local');
const MODELS_SRC_DIR = path.join(HERE, 'configs', 'models');
const MODELS_DEST_DIR = path.join(VENDOR_DIR, 'configs', 'models');

function run(cmd: string, args: string[], cwd?: string): void {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, {
    cwd,
    stdio: 'inherit',
  });
}

function ensureTool(tool: string): void {
  try {
    execFileSync(
      tool,
      [
        '--version',
      ],
      {
        stdio: 'ignore',
      },
    );
  } catch {
    throw new Error(`Required tool '${tool}' not found on PATH.`);
  }
}

function cloneRepo(ref: string): void {
  if (fs.existsSync(path.join(VENDOR_DIR, '.git'))) {
    console.log(`Vendor clone already present at ${VENDOR_DIR}`);
    return;
  }
  console.log(`Cloning ${REPO_URL} @ ${ref}`);
  run('git', [
    'clone',
    '--filter=blob:none',
    REPO_URL,
    VENDOR_DIR,
  ]);
  run(
    'git',
    [
      'checkout',
      ref,
    ],
    VENDOR_DIR,
  );
}

function installDeps(): void {
  console.log('Installing Python deps (uv sync)…');
  run(
    'uv',
    [
      'sync',
    ],
    VENDOR_DIR,
  );
}

function installModelCatalog(): void {
  if (!fs.existsSync(MODELS_SRC_DIR)) {
    return;
  }
  fs.mkdirSync(MODELS_DEST_DIR, {
    recursive: true,
  });
  for (const file of fs.readdirSync(MODELS_SRC_DIR)) {
    if (!file.endsWith('.yaml')) {
      continue;
    }
    fs.copyFileSync(path.join(MODELS_SRC_DIR, file), path.join(MODELS_DEST_DIR, file));
    console.log(`  installed model catalog entry: ${file}`);
  }
}

function wireProblems(): void {
  fs.mkdirSync(PROBLEMS_DIR, {
    recursive: true,
  });
  for (const name of fs.readdirSync(PROBLEMS_SRC_DIR)) {
    const source = path.join(PROBLEMS_SRC_DIR, name);
    if (!fs.existsSync(path.join(source, 'config.yaml'))) {
      continue;
    }
    const link = path.join(PROBLEMS_DIR, name);
    fs.rmSync(link, {
      recursive: true,
      force: true,
    });
    fs.symlinkSync(source, link, 'dir');
    console.log(`  wired problem '${name}'`);
  }
}

function main(): void {
  ensureTool('git');
  ensureTool('uv');

  const ref = process.env.SCBENCH_REF ?? DEFAULT_REF;
  cloneRepo(ref);
  installDeps();
  installModelCatalog();
  wireProblems();

  console.log('\nSetup complete. Run the eval with:');
  console.log('  bun evals/slopcodebench/run.ts --problem greeter');
}

main();
