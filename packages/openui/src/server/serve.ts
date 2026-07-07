/**
 * `serveOpenUi` — wrap a Noetic `AgentHarness` in a web-standard fetch handler
 * that speaks the OpenUI transport protocol. Runtime-neutral: built on
 * `Request`/`Response`/`ReadableStream`, no `node:*` imports, so it runs on
 * Node, Bun, workers, and the edge.
 *
 * - `POST` with `{ prompt }`     → runs a turn, streams the surface as SSE.
 * - `POST` with `{ event }`      → ingests a client UI event, returns 202.
 * - `GET`                        → returns the current surface snapshot.
 */

import type { AgentHarnessContract, StreamEvent } from '@noetic-tools/types';
import type { OpenUiSurfaceLayer } from '../layer/surface';
import { createUiEventItem, UiEventSchema } from '../layer/surface';
import type { OpenUiServerMessage } from './protocol';
import { encodeSseFrame, OPENUI_PROTOCOL, snapshotMessage, translateStreamEvent } from './protocol';

//#region Options

/** @public Options for {@link serveOpenUi}. */
export interface ServeOpenUiOptions {
  /** The surface layer instance installed on the harness — read for snapshots. */
  surface: OpenUiSurfaceLayer;
  /** Thread the UI conversation runs on. Defaults to the harness default thread. */
  threadId?: string;
}

/** @public A minimal request the handler understands (subset of the Fetch `Request`). */
export interface OpenUiRequest {
  method: string;
  json(): Promise<unknown>;
}

/** @public The request body shapes the handler accepts. */
export interface OpenUiRequestBody {
  prompt?: string;
  event?: unknown;
}

//#endregion

//#region Handler

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  'x-openui-protocol': OPENUI_PROTOCOL,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-openui-protocol': OPENUI_PROTOCOL,
    },
  });
}

function sseStream(
  agentName: string,
  first: OpenUiServerMessage,
  events: AsyncIterable<StreamEvent>,
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(encodeSseFrame(first)));
      try {
        for await (const event of events) {
          const message = translateStreamEvent(event, agentName);
          if (message === null) {
            continue;
          }
          controller.enqueue(encoder.encode(encodeSseFrame(message)));
          if (message.type === 'done') {
            break;
          }
        }
      } catch (e) {
        controller.enqueue(
          encoder.encode(
            encodeSseFrame({
              type: 'error',
              message: e instanceof Error ? e.message : String(e),
            }),
          ),
        );
      }
      controller.close();
    },
  });
  return new Response(body, {
    headers: SSE_HEADERS,
  });
}

/**
 * Build a fetch-style handler `(request) => Promise<Response>` for a harness.
 * @public
 */
export function serveOpenUi(
  harness: AgentHarnessContract,
  options: ServeOpenUiOptions,
): (request: OpenUiRequest) => Promise<Response> {
  const agentName = harness.config.name;
  const scope = options.threadId
    ? {
        threadId: options.threadId,
      }
    : undefined;

  return async (request: OpenUiRequest): Promise<Response> => {
    if (request.method === 'GET') {
      const state = options.surface.readState();
      return jsonResponse(
        state
          ? snapshotMessage(state)
          : {
              type: 'snapshot',
              source: '',
              vars: {},
              version: 0,
            },
      );
    }

    if (request.method !== 'POST') {
      return jsonResponse(
        {
          error: 'method not allowed',
        },
        405,
      );
    }

    const body = await parseBody(request);
    if (body.event !== undefined) {
      const parsed = UiEventSchema.safeParse(body.event);
      if (!parsed.success) {
        return jsonResponse(
          {
            error: 'invalid ui event',
            issues: parsed.error.issues,
          },
          400,
        );
      }
      await harness.execute(createUiEventItem(parsed.data), scope);
      return jsonResponse(
        {
          accepted: true,
        },
        202,
      );
    }

    if (typeof body.prompt !== 'string') {
      return jsonResponse(
        {
          error: 'expected { prompt } or { event }',
        },
        400,
      );
    }

    const state = options.surface.readState();
    const first: OpenUiServerMessage = state
      ? snapshotMessage(state)
      : {
          type: 'snapshot',
          source: '',
          vars: {},
          version: 0,
        };
    await harness.execute(body.prompt, scope);
    return sseStream(agentName, first, harness.getFullStream(scope));
  };
}

async function parseBody(request: OpenUiRequest): Promise<OpenUiRequestBody> {
  const raw = await request.json();
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const record = Object.fromEntries(Object.entries(raw));
  return {
    prompt: typeof record.prompt === 'string' ? record.prompt : undefined,
    event: record.event,
  };
}

//#endregion
