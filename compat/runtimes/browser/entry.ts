/**
 * Browser bundle entry. Bundled by `scripts/build-bundles.ts` into
 * `dist/browser/bundle.js` and loaded by a headless Chromium page driven by
 * `runtimes/browser/run.ts`.
 *
 * It imports ONLY `core-smoke.ts` (which imports only `@noetic-tools/core`).
 * Importing the code-agent smoke here would pull code-agent's Node-coupled
 * `dist` into the browser bundle and break it at load time.
 *
 * The Playwright harness injects the OpenRouter key and model onto `window`
 * before the bundle runs, then polls `window.__noeticSmoke` for the outcome.
 */

import { runCoreOnlySmoke } from '../../shared/core-smoke.js';

const SKIP_REASON =
  'code-agent dist statically imports node:url/LSP modules; not browser-bundleable';

async function run(): Promise<void> {
  window.__noeticSmoke = {
    status: 'pending',
  };
  try {
    const apiKey = window.__OPENROUTER_API_KEY__;
    if (!apiKey) {
      throw new Error('window.__OPENROUTER_API_KEY__ is not set');
    }
    const result = await runCoreOnlySmoke(
      {
        runtime: 'browser',
        apiKey,
        model: window.__NOETIC_COMPAT_MODEL__,
      },
      SKIP_REASON,
    );
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
