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

const activePromptStreams = new WeakMap<object, Set<string>>();

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

interface SseStreamOptions {
  agentName: string;
  first: OpenUiServerMessage;
  events: AsyncIterable<StreamEvent>;
  /** Runs once the pump ends — normal completion, error, OR client disconnect. */
  onFinished?: () => void;
}

function sseStream({ agentName, first, events, onFinished }: SseStreamOptions): Response {
  const encoder = new TextEncoder();
  /* `cancel()` fires when the client disconnects; without it the pump loop
   * kept iterating the broadcaster into a dead controller until `done` —
   * enqueue on a cancelled stream throws, abandoning the iterator without
   * return(), and long turns pumped events to nobody. */
  let cancelled = false;
  let iterator: AsyncIterator<StreamEvent> | undefined;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (message: OpenUiServerMessage): boolean => {
        if (cancelled) {
          return false;
        }
        try {
          controller.enqueue(encoder.encode(encodeSseFrame(message)));
          return true;
        } catch {
          cancelled = true;
          return false;
        }
      };
      send(first);
      try {
        iterator = events[Symbol.asyncIterator]();
        for (;;) {
          const next = await iterator.next();
          if (next.done || cancelled) {
            break;
          }
          const message = translateStreamEvent(next.value, agentName);
          if (message === null) {
            continue;
          }
          if (!send(message) || message.type === 'done') {
            break;
          }
        }
      } catch (e) {
        send({
          type: 'error',
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        onFinished?.();
        await iterator?.return?.().catch(() => undefined);
      }
      if (!cancelled) {
        try {
          controller.close();
        } catch {
          // already closed by cancellation
        }
      }
    },
    cancel() {
      cancelled = true;
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
  const threadId = options.threadId;
  const scope = threadId
    ? {
        threadId,
      }
    : undefined;
  /* One prompt stream at a time per harness + thread. Multiple handlers can
   * wrap the same harness, so the lock must not be closure-local. */
  const promptKey = threadId ?? '__default__';
  let activePrompts = activePromptStreams.get(harness);
  if (!activePrompts) {
    activePrompts = new Set();
    activePromptStreams.set(harness, activePrompts);
  }

  const emptySnapshot: OpenUiServerMessage = {
    type: 'snapshot',
    source: '',
    vars: {},
    version: 0,
  };

  return async (request: OpenUiRequest): Promise<Response> => {
    if (request.method === 'GET') {
      const state = options.surface.readState(threadId);
      return jsonResponse(state ? snapshotMessage(state) : emptySnapshot);
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
      // Echo the seq + the version the client can poll against (GET returns
      // the authoritative surface). The event applies asynchronously, so the
      // version here is pre-application — a strictly-greater version on the
      // next GET confirms the event landed.
      return jsonResponse(
        {
          accepted: true,
          seq: parsed.data.seq,
          version: options.surface.readState(threadId)?.version ?? 0,
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

    if (activePrompts.has(promptKey)) {
      return jsonResponse(
        {
          error: 'a prompt turn is already streaming on this thread; retry when it completes',
        },
        409,
      );
    }
    activePrompts.add(promptKey);

    const state = options.surface.readState(threadId);
    const first: OpenUiServerMessage = state ? snapshotMessage(state) : emptySnapshot;
    try {
      await harness.execute(body.prompt, scope);
    } catch (e) {
      activePrompts.delete(promptKey);
      throw e;
    }
    return sseStream({
      agentName,
      first,
      events: harness.getFullStream(scope),
      onFinished: () => {
        activePrompts.delete(promptKey);
      },
    });
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
