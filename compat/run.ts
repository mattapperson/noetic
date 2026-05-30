/**
 * Local orchestrator for the cross-platform deployment smoke suite.
 *
 * It (re)builds the runtime bundles, then runs each target's smoke as its own
 * process and prints a pass/fail summary. Each target makes a *live* OpenRouter
 * call, so `OPENROUTER_API_KEY` must be set. The Cloudflare `--deploy` path also
 * needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
 *
 * Usage (from `compat/`):
 *   bun run all                       # every runtime (Cloudflare deploys for real)
 *   bun run.ts node bun deno          # only the named runtimes
 *   bun run.ts --cf-local             # run Cloudflare in local workerd instead
 *   bun run.ts --skip-build           # reuse existing bundles
 *
 * Prerequisite: `bun run pack:packages` + `npm install` (extracts the tarballs).
 * The default Cloudflare deploy needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID.
 */

import { fileURLToPath } from 'node:url';
import { $ } from 'bun';
import { Runtime } from './shared/types.js';

const COMPAT_DIR = fileURLToPath(new URL('.', import.meta.url));

interface RuntimeTarget {
  id: Runtime;
  /** Whether the host has the tool needed to run this target. */
  available: () => Promise<boolean>;
  /** Argv for the target's smoke process. */
  command: (deployCf: boolean) => string[];
}

async function hasCommand(binary: string): Promise<boolean> {
  return (await $`which ${binary}`.nothrow().quiet()).exitCode === 0;
}

const TARGETS: ReadonlyArray<RuntimeTarget> = [
  {
    id: Runtime.Node,
    available: () => hasCommand('node'),
    command: () => [
      'node',
      'dist/node/run.mjs',
    ],
  },
  {
    id: Runtime.Bun,
    available: () => hasCommand('bun'),
    command: () => [
      'bun',
      '--no-install',
      'runtimes/cli.ts',
    ],
  },
  {
    id: Runtime.Deno,
    available: () => hasCommand('deno'),
    command: () => [
      'deno',
      'run',
      '--allow-net',
      '--allow-env',
      '--allow-read',
      'dist/deno/run.mjs',
    ],
  },
  {
    id: Runtime.Browser,
    available: () => hasCommand('bun'),
    command: () => [
      'bun',
      '--no-install',
      'runtimes/browser/run.ts',
    ],
  },
  {
    id: Runtime.Cloudflare,
    available: () => hasCommand('bun'),
    command: (cfLocal) => {
      const base = [
        'bun',
        '--no-install',
        'runtimes/cloudflare/run.ts',
      ];
      return cfLocal
        ? [
            ...base,
            '--local',
          ]
        : base;
    },
  },
];

async function runTarget(target: RuntimeTarget, cfLocal: boolean): Promise<boolean> {
  const [bin, ...args] = target.command(cfLocal);
  console.log(`\n──── ${target.id} ────`);
  const result = await $`${bin} ${args}`.cwd(COMPAT_DIR).nothrow();
  return result.exitCode === 0;
}

function parseSelection(argv: ReadonlyArray<string>): {
  selected: ReadonlyArray<Runtime>;
  cfLocal: boolean;
  skipBuild: boolean;
} {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const names = argv.filter((arg) => !arg.startsWith('--'));
  const known = new Set<string>(TARGETS.map((t) => t.id));
  const selected = names.filter((name): name is Runtime => known.has(name));
  return {
    selected: selected.length > 0 ? selected : TARGETS.map((t) => t.id),
    cfLocal: flags.has('--cf-local'),
    skipBuild: flags.has('--skip-build'),
  };
}

async function main(): Promise<void> {
  if (!process.env.OPENROUTER_API_KEY) {
    console.error('OPENROUTER_API_KEY is not set');
    process.exitCode = 1;
    return;
  }

  const { selected, cfLocal, skipBuild } = parseSelection(process.argv.slice(2));

  if (!skipBuild) {
    console.log('• building runtime bundles');
    await $`bun --no-install scripts/build-bundles.ts`.cwd(COMPAT_DIR);
  }

  const outcomes: Array<{
    id: Runtime;
    ok: boolean;
    skipped: boolean;
  }> = [];
  for (const target of TARGETS) {
    if (!selected.includes(target.id)) {
      continue;
    }
    if (!(await target.available())) {
      console.log(`\n──── ${target.id} ──── (skipped: tool not installed)`);
      outcomes.push({
        id: target.id,
        ok: false,
        skipped: true,
      });
      continue;
    }
    const ok = await runTarget(target, cfLocal);
    outcomes.push({
      id: target.id,
      ok,
      skipped: false,
    });
  }

  console.log('\n═══ summary ═══');
  for (const outcome of outcomes) {
    const status = outcome.skipped ? '∅ skipped' : outcome.ok ? '✓ pass' : '✗ fail';
    console.log(`  ${outcome.id.padEnd(12)} ${status}`);
  }

  const failed = outcomes.filter((o) => !o.skipped && !o.ok);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

await main();
