/**
 * Cloudflare Workers deployment target.
 *
 *   - default (deploy): actually deploys the worker to Cloudflare with the
 *                       account credentials, hits the live `*.workers.dev` URL,
 *                       asserts, then deletes the worker. This is the meaningful
 *                       Cloudflare deployment test.
 *   - `--local`:        runs the worker in wrangler's local workerd via
 *                       `unstable_dev` instead (no account needed).
 *
 * Run from `compat/`:
 *   bun run smoke:cloudflare            # real deploy + run + teardown
 *   bun run smoke:cloudflare -- --local # local workerd
 */

import { fileURLToPath } from 'node:url';
import { $ } from 'bun';
import { unstable_dev } from 'wrangler';
import { formatFailure, formatSuccess } from '../../shared/report.js';
import type { SmokeResult } from '../../shared/types.js';
import { Runtime } from '../../shared/types.js';

const WORKER_PATH = fileURLToPath(new URL('./worker.ts', import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL('./wrangler.toml', import.meta.url));
const CF_DIR = fileURLToPath(new URL('.', import.meta.url));
const WORKER_NAME = 'noetic-compat-smoke';

function isSmokeResult(value: unknown): value is SmokeResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    value.ok === true &&
    'runtime' in value &&
    'core' in value
  );
}

async function assertResult(value: unknown): Promise<SmokeResult> {
  if (!isSmokeResult(value)) {
    throw new Error(`worker did not return a smoke result: ${JSON.stringify(value)}`);
  }
  return value;
}

async function runLocal(apiKey: string, model: string | undefined): Promise<SmokeResult> {
  const worker = await unstable_dev(WORKER_PATH, {
    config: CONFIG_PATH,
    vars: model
      ? {
          OPENROUTER_API_KEY: apiKey,
          NOETIC_COMPAT_MODEL: model,
        }
      : {
          OPENROUTER_API_KEY: apiKey,
        },
    experimental: {
      disableExperimentalWarning: true,
    },
  });
  try {
    const response = await worker.fetch('/');
    if (!response.ok) {
      throw new Error(`worker responded ${response.status}: ${await response.text()}`);
    }
    return assertResult(await response.json());
  } finally {
    await worker.stop();
  }
}

function extractWorkersDevUrl(output: string): string {
  const match = output.match(/https:\/\/[^\s]+\.workers\.dev/);
  if (!match) {
    throw new Error(`could not find a *.workers.dev URL in deploy output:\n${output}`);
  }
  return match[0];
}

async function runDeploy(apiKey: string, model: string | undefined): Promise<SmokeResult> {
  const env = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN ?? '',
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
  };
  const varArgs = [
    '--var',
    `OPENROUTER_API_KEY:${apiKey}`,
  ];
  if (model) {
    varArgs.push('--var', `NOETIC_COMPAT_MODEL:${model}`);
  }

  console.log(`• deploying ${WORKER_NAME} to Cloudflare`);
  const deploy = await $`bunx wrangler deploy --config ${CONFIG_PATH} ${varArgs}`
    .cwd(CF_DIR)
    .env(env)
    .text();
  const url = extractWorkersDevUrl(deploy);

  try {
    console.log(`• worker live at ${url}; invoking`);
    // Newly-propagated workers can 404/525 briefly; retry a few times.
    const result = await fetchWithRetry(url, 5);
    return result;
  } finally {
    console.log(`• deleting ${WORKER_NAME}`);
    await $`bunx wrangler delete --config ${CONFIG_PATH} --name ${WORKER_NAME} --force`
      .cwd(CF_DIR)
      .env(env)
      .nothrow()
      .quiet();
  }
}

async function fetchWithRetry(url: string, attempts: number): Promise<SmokeResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return assertResult(await response.json());
      }
      lastError = new Error(`worker responded ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw lastError instanceof Error ? lastError : new Error('worker never became reachable');
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(formatFailure(Runtime.Cloudflare, 'OPENROUTER_API_KEY is not set'));
    process.exitCode = 1;
    return;
  }
  const model = process.env.NOETIC_COMPAT_MODEL;
  // Default to a real deploy (the meaningful Cloudflare test). `--local` runs
  // the worker in wrangler's local workerd via `unstable_dev` instead.
  const localMode = process.argv.includes('--local');

  try {
    const result = localMode ? await runLocal(apiKey, model) : await runDeploy(apiKey, model);
    console.log(JSON.stringify(result));
    console.log(formatSuccess(result));
  } catch (error) {
    console.error(formatFailure(Runtime.Cloudflare, error));
    process.exitCode = 1;
  }
}

await main();
