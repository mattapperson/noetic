/**
 * Browser deployment target. Serves the pre-built browser bundle over
 * `http://localhost` (so OpenRouter sees a real, secure-context origin rather
 * than a `file://`/`null` origin) and drives a headless Chromium page through
 * Playwright. The page runs the smoke entirely in the browser — including the
 * live OpenRouter `fetch` — and the harness reads the structured result back.
 *
 * Run from `compat/`: `bun run smoke:browser` (after `build:bundles`).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { formatFailure, formatSuccess } from '../../shared/report.js';
import type { SmokeResult } from '../../shared/types.js';
import { Runtime } from '../../shared/types.js';

const BUNDLE_PATH = fileURLToPath(new URL('../../dist/browser/bundle.js', import.meta.url));

/** Permissive CORS headers the proxy adds so the in-page fetch is accepted. */
const PROXY_CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': '*',
  'access-control-allow-headers': '*',
};

const PAGE_HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>noetic compat browser smoke</title></head>
  <body>
    <script type="module" src="/bundle.js"></script>
  </body>
</html>`;

interface SmokeState {
  status: 'pending' | 'ok' | 'error';
  result?: SmokeResult;
  error?: string;
}

function isSmokeState(value: unknown): value is SmokeState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    typeof value.status === 'string'
  );
}

async function serveBundle(bundle: string): Promise<{
  origin: string;
  stop: () => void;
}> {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/bundle.js') {
        return new Response(bundle, {
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
          },
        });
      }
      return new Response(PAGE_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
        },
      });
    },
  });
  return {
    origin: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(formatFailure(Runtime.Browser, 'OPENROUTER_API_KEY is not set'));
    process.exitCode = 1;
    return;
  }

  const model = process.env.NOETIC_COMPAT_MODEL ?? null;
  const bundle = await readFile(BUNDLE_PATH, 'utf8');
  const { origin, stop } = await serveBundle(bundle);
  const browser = await chromium.launch({
    headless: true,
  });

  try {
    const page = await browser.newPage();

    // OpenRouter's CORS policy rejects the SDK's custom `x-openrouter-callmodel`
    // header on preflight, so a browser cannot call it directly — real browser
    // apps proxy LLM calls through their own backend. Playwright stands in for
    // that proxy: it forwards the request server-side (no CORS) and returns the
    // response with permissive CORS headers, so the in-page noetic code runs
    // unmodified. This proves core loads and executes in the browser.
    await page.route('https://openrouter.ai/**', async (route) => {
      if (route.request().method() === 'OPTIONS') {
        await route.fulfill({
          status: 204,
          headers: PROXY_CORS_HEADERS,
        });
        return;
      }
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          ...PROXY_CORS_HEADERS,
        },
      });
    });

    await page.addInitScript(
      ([key, modelId]) => {
        window.__OPENROUTER_API_KEY__ = key;
        if (modelId) {
          window.__NOETIC_COMPAT_MODEL__ = modelId;
        }
      },
      [
        apiKey,
        model,
      ],
    );

    await page.goto(origin, {
      waitUntil: 'load',
    });
    await page.waitForFunction(
      () => window.__noeticSmoke && window.__noeticSmoke.status !== 'pending',
      undefined,
      {
        timeout: 60_000,
      },
    );

    const state = await page.evaluate(() => window.__noeticSmoke);
    if (!isSmokeState(state)) {
      throw new Error('browser did not report a smoke result');
    }
    if (state.status === 'error' || !state.result) {
      throw new Error(state.error ?? 'unknown browser smoke error');
    }

    console.log(JSON.stringify(state.result));
    console.log(formatSuccess(state.result));
  } catch (error) {
    console.error(formatFailure(Runtime.Browser, error));
    process.exitCode = 1;
  } finally {
    await browser.close();
    stop();
  }
}

await main();
