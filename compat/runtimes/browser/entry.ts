/**
 * Browser bundle entry. Bundled by `scripts/build-bundles.ts` into
 * `dist/browser/bundle.js` (via esbuild + a node-polyfill plugin, the same kind
 * of pipeline a real Next.js/webpack/esbuild app uses) and loaded by a headless
 * Chromium page driven by `runtimes/browser/run.ts`.
 *
 * It runs the full smoke (core + code-agent). The Playwright harness injects the
 * OpenRouter key and model onto `window` before the bundle runs, then polls
 * `window.__noeticSmoke` for the outcome.
 */

import { runSmoke } from '../../shared/smoke.js';

async function run(): Promise<void> {
  window.__noeticSmoke = {
    status: 'pending',
  };
  try {
    const apiKey = window.__OPENROUTER_API_KEY__;
    if (!apiKey) {
      throw new Error('window.__OPENROUTER_API_KEY__ is not set');
    }
    const result = await runSmoke({
      runtime: 'browser',
      apiKey,
      model: window.__NOETIC_COMPAT_MODEL__,
    });
    window.__noeticSmoke = {
      status: 'ok',
      result,
    };
  } catch (error) {
    window.__noeticSmoke = {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

void run();
