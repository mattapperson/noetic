/**
 * The demo's HTTP boundary.
 *
 *   POST /agent  { prompt }  → runs a real agent turn, streams the rendered
 *                              OpenUI Lang back statement-by-statement as SSE
 *   GET  /agent              → snapshot of the current document
 *
 * The turn is 100% the real pipeline: `harness.run` executes `step.llm` with the
 * `openUi(library)` codec and the `openUiSurface()` layer, the model calls the
 * `search_listings`/`quote_price` tools, and the returned value is a materialized
 * `UiDocument`. We then stream that document's statements to the client (paced so
 * cards reveal one by one) using the documented `statement`/`snapshot`/`done`
 * frame vocabulary.
 *
 * NOTE: we deliberately do NOT use `@noetic-tools/openui/server`'s `serveOpenUi`.
 * That shipped transport terminates the SSE stream at the first
 * `response.completed` (the tool-call round, before the render) and relies on
 * `openui.*` framework events that the codec doesn't surface through
 * `getFullStream` — so it streams zero statements. See the demo README.
 *
 * Run: OPENROUTER_API_KEY=… bun run examples/openui-airbnb/server/server.ts
 */

import type { Context } from '@noetic-tools/core';
import type { UiDocument } from '@noetic-tools/openui';
import { serializeAssignment } from '@noetic-tools/openui';
import { createStaysHarness, stays } from './agent';

const PORT = Number(process.env.PORT ?? 8787);

const { harness } = createStaysHarness();
// One persistent context so history + the surface carry across turns (a card
// click can reference "the stay you were just looking at").
const ctx: Context = harness.createContext();
let lastDoc: UiDocument | undefined;

//#region SSE framing

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function frame(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

//#endregion

//#region Turn → stream

function streamTurn(prompt: string): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const doc = await harness.run(stays, prompt, ctx);
        lastDoc = doc;
        // Reveal each statement in author order — real model output, paced.
        for (const ref of doc.order) {
          const assignment = doc.assignments[ref];
          if (!assignment) {
            continue;
          }
          controller.enqueue(
            frame({
              type: 'statement',
              ref: assignment.ref,
              kind: assignment.kind,
              source: serializeAssignment(assignment),
            }),
          );
          await delay(ref === doc.root ? 0 : 110);
        }
        controller.enqueue(
          frame({
            type: 'done',
          }),
        );
      } catch (e) {
        controller.enqueue(
          frame({
            type: 'error',
            message: e instanceof Error ? e.message : String(e),
          }),
        );
      }
      controller.close();
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      ...CORS,
    },
  });
}

function snapshotResponse(): Response {
  const source = lastDoc
    ? lastDoc.order
        .map((r) => lastDoc?.assignments[r])
        .filter(Boolean)
        .map((a) => serializeAssignment(a!))
        .join('\n')
    : '';
  return Response.json(
    {
      type: 'snapshot',
      source,
      vars: {},
      version: lastDoc ? 1 : 0,
    },
    {
      headers: CORS,
    },
  );
}

//#endregion

//#region Server

Bun.serve({
  port: PORT,
  idleTimeout: 240,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: CORS,
      });
    }
    if (url.pathname !== '/agent') {
      return new Response('not found', {
        status: 404,
        headers: CORS,
      });
    }
    if (request.method === 'GET') {
      return snapshotResponse();
    }
    const payload = await request.json();
    const prompt =
      typeof payload === 'object' && payload !== null && 'prompt' in payload
        ? String(payload.prompt)
        : '';
    if (prompt.length === 0) {
      return Response.json(
        {
          error: 'expected { prompt }',
        },
        {
          status: 400,
          headers: CORS,
        },
      );
    }
    return streamTurn(prompt);
  },
});

if (!process.env.OPENROUTER_API_KEY) {
  console.warn('⚠  OPENROUTER_API_KEY is not set — model calls will fail.');
}
console.log(`stays agent listening on http://localhost:${PORT}/agent`);

//#endregion
