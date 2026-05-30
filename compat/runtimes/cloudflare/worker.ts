/**
 * Cloudflare Worker entry. Runs the full smoke (core + code-agent) on every
 * request and returns the structured result as JSON.
 *
 * code-agent's built `dist` calls `createRequire(import.meta.url)` at module
 * load. In a Worker bundle `import.meta.url` is otherwise `undefined`, so
 * `wrangler.toml` defines it to a valid file URL (wrangler bundles with esbuild,
 * which substitutes the literal). Combined with `nodejs_compat` supplying
 * `node:module`/`node:url`, code-agent loads and runs here.
 */

import { formatFailure } from '../../shared/report.js';
import { runSmoke } from '../../shared/smoke.js';
import { Runtime } from '../../shared/types.js';

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
      const result = await runSmoke({
        runtime: Runtime.Cloudflare,
        apiKey,
        model: env.NOETIC_COMPAT_MODEL,
      });
      return Response.json(result);
    } catch (error) {
      return new Response(formatFailure(Runtime.Cloudflare, error), {
        status: 500,
      });
    }
  },
};
