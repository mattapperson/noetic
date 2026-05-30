/**
 * Full cross-platform deployment smoke for `@noetic-tools/core` and
 * `@noetic-tools/code-agent`, used by the Node, Bun, Deno, and Cloudflare Worker
 * targets (every runtime with Node compatibility).
 *
 * The browser target does NOT import this module — code-agent's built `dist`
 * statically pulls in `node:url`/LSP modules and cannot be bundled for a
 * browser. The browser entry uses `runCoreOnlySmoke` from `core-smoke.ts`
 * instead. Keeping the code-agent import out of `core-smoke.ts` is what makes
 * the browser bundle viable.
 */

import { runCodeAgentSmoke } from './code-agent-smoke.js';
import { DEFAULT_MODEL, runCoreSmoke } from './core-smoke.js';
import type { SmokeOptions, SmokeResult } from './types.js';

/**
 * Run the full smoke (core + code-agent) and return a structured result. Throws
 * if any live call or portable exercise fails so callers can surface the error.
 */
export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const clock = options.now ?? (() => Date.now());
  const startedAt = clock();

  if (!options.apiKey) {
    throw new Error('runSmoke requires an OpenRouter apiKey');
  }

  const includeCodeAgent = options.includeCodeAgent ?? true;
  const core = await runCoreSmoke(options.apiKey, model);
  const codeAgent = includeCodeAgent ? await runCodeAgentSmoke(options.apiKey, model) : null;

  return {
    ok: true,
    runtime: options.runtime,
    model,
    core,
    codeAgent,
    codeAgentSkipReason: includeCodeAgent
      ? undefined
      : 'code-agent dist statically imports node:url/LSP modules; not browser-bundleable',
    durationMs: clock() - startedAt,
  };
}
