/**
 * Full cross-platform deployment smoke for `@noetic-tools/core` and
 * `@noetic-tools/code-agent`, used by every runtime target.
 *
 * The split between `core-smoke.ts` and `code-agent-smoke.ts` keeps core's
 * (fully portable) surface independent of code-agent's Node-coupled `dist`. The
 * browser and Cloudflare Worker targets still run both: the browser bundles
 * code-agent through esbuild + node polyfills, and the Worker defines
 * `import.meta.url` so code-agent's load-time `createRequire` works.
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

  const core = await runCoreSmoke(options.apiKey, model);
  const codeAgent = await runCodeAgentSmoke(options.apiKey, model);

  return {
    ok: true,
    runtime: options.runtime,
    model,
    core,
    codeAgent,
    durationMs: clock() - startedAt,
  };
}
