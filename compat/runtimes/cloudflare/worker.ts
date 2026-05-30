/**
 * Cloudflare Worker entry. Runs the core smoke on every request and returns the
 * structured result as JSON.
 *
 * It imports ONLY `core-smoke.ts`. code-agent's built `dist` calls
 * `createRequire(import.meta.url)` at module load, and `import.meta.url` is
 * `undefined` in a bundled Worker — so importing the code-agent smoke would
 * crash the worker before it ever handles a request, even with `nodejs_compat`.
 * That makes code-agent (as published) undeployable to Workers; the suite
 * records it as skipped here, the same as in the browser.
 */

import { runCoreOnlySmoke } from '../../shared/core-smoke.js';
import { formatFailure } from '../../shared/report.js';
import { Runtime } from '../../shared/types.js';

const SKIP_REASON =
  'code-agent dist calls createRequire(import.meta.url) at load; import.meta.url is undefined in a Worker bundle';

interface Env {
  OPENROUTER_API_KEY?: string;
  NOETIC_COMPAT_MODEL?: string;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    try {
      const apiKey = env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error('OPENROUTER_API_KEY is not set on the worker');
      }
      const result = await runCoreOnlySmoke(
        {
          runtime: Runtime.Cloudflare,
          apiKey,
          model: env.NOETIC_COMPAT_MODEL,
        },
        SKIP_REASON,
      );
      return Response.json(result);
    } catch (error) {
      return new Response(formatFailure(Runtime.Cloudflare, error), {
        status: 500,
      });
    }
  },
};
