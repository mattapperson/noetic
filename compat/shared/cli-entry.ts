/**
 * Generic command-line entry shared by the Node, Bun, and Deno targets. It
 * detects which runtime it is executing under, reads the OpenRouter key from the
 * environment, runs the smoke, prints the result, and sets the exit code.
 *
 * Browser and Cloudflare Workers have their own entries because they receive the
 * key by injection rather than from a process environment.
 */

import { formatFailure, formatSuccess } from './report.js';
import { runSmoke } from './smoke.js';
import { Runtime } from './types.js';

/** Detect the host runtime from its global markers. */
export function detectRuntime(): Runtime {
  if (globalThis.Deno) {
    return Runtime.Deno;
  }
  if ('Bun' in globalThis) {
    return Runtime.Bun;
  }
  return Runtime.Node;
}

function readApiKey(): string | undefined {
  const fromProcess = globalThis.process?.env?.OPENROUTER_API_KEY;
  if (fromProcess) {
    return fromProcess;
  }
  return globalThis.Deno?.env.get('OPENROUTER_API_KEY');
}

function setExitCode(code: number): void {
  if (globalThis.process) {
    globalThis.process.exitCode = code;
    return;
  }
  if (code !== 0 && globalThis.Deno) {
    globalThis.Deno.exit(code);
  }
}

/** Run the smoke for the detected runtime and report the outcome. */
export async function main(): Promise<void> {
  const runtime = detectRuntime();
  const apiKey = readApiKey();

  if (!apiKey) {
    console.error(formatFailure(runtime, 'OPENROUTER_API_KEY is not set'));
    setExitCode(1);
    return;
  }

  try {
    const result = await runSmoke({
      runtime,
      apiKey,
      model: globalThis.process?.env?.NOETIC_COMPAT_MODEL,
    });
    console.log(JSON.stringify(result));
    console.log(formatSuccess(result));
  } catch (error) {
    console.error(formatFailure(runtime, error));
    setExitCode(1);
  }
}
