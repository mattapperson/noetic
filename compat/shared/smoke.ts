/**
 * Cross-platform deployment smoke for `@noetic-tools/core`, used by every
 * runtime target. Core's surface is fully portable (no `node:` builtins
 * referenced at module load), so the same smoke runs on Node, Bun, Deno, the
 * browser, and a Cloudflare Worker unchanged.
 */

import { DEFAULT_MODEL, runCoreSmoke } from './core-smoke.js';
import type { SmokeOptions, SmokeResult } from './types.js';

/**
 * Run the smoke and return a structured result. Throws if the live call or any
 * portable exercise fails so callers can surface the error.
 */
export async function runSmoke(options: SmokeOptions): Promise<SmokeResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const clock = options.now ?? (() => Date.now());
  const startedAt = clock();

  if (!options.apiKey) {
    throw new Error('runSmoke requires an OpenRouter apiKey');
  }

  const core = await runCoreSmoke(options.apiKey, model);

  return {
    ok: true,
    runtime: options.runtime,
    model,
    core,
    durationMs: clock() - startedAt,
  };
}
