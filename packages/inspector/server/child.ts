/**
 * Agent child entry point. One process per agent-code revision; the host
 * spawns it with config in env and restarts it when the agent file changes.
 *
 *   POST /chat     enqueue a user message         GET /stream   SSE frames
 *   POST /abort    abort the in-flight turn       GET /layers   layer roster
 *   GET  /status   harness status                 GET /layers/:id/state
 *   GET  /history  persisted item log             GET /preview  next-turn context window
 *   GET  /usage    last per-layer token usage     GET /trace    span list
 */

import type { LastLayerUsage } from '@noetic-tools/core';
import { z } from 'zod';
import type { AgentBoot } from './child-runtime';
import { bootAgent } from './child-runtime';
import type { SseHub } from './sse-hub';
import { CORS_HEADERS, createSseHub, jsonResponse } from './sse-hub';
import type { LayerStateResult, WireSpan } from './wire-types';

//#region Config

const EnvSchema = z.object({
  INSPECTOR_AGENT_FILE: z.string().min(1),
  INSPECTOR_DATA_DIR: z.string().min(1),
  INSPECTOR_THREAD_ID: z.string().min(1).default('inspector-main'),
  INSPECTOR_CHILD_PORT: z.coerce.number().int().positive().default(4701),
});

const ChatRequestSchema = z.object({
  text: z.string().min(1),
  messageId: z.string().optional(),
  deliveryMode: z
    .enum([
      'next-turn',
      'between-rounds',
      'next-item',
      'interrupt',
    ])
    .optional(),
});

//#endregion

//#region Turn watching

/**
 * After each enqueue, wait for the queue to drain, then persist the turn's
 * full item log and broadcast its `lastLayerUsage`. The rewrite from
 * `response.items` is the only persistence path — the item stream carries
 * model output only, so appending from it would drop the user's messages.
 * Single-flight: one watcher covers however many messages are queued.
 */
function createTurnWatcher(boot: AgentBoot, threadId: string, hub: SseHub) {
  let usage: LastLayerUsage | undefined;
  let inFlight = false;

  return {
    lastUsage: (): LastLayerUsage | undefined => usage,
    watch(): void {
      if (inFlight) {
        return;
      }
      inFlight = true;
      boot.harness
        .getAgentResponse({
          threadId,
        })
        .then(async (response) => {
          await boot.sessionStore.writeItems(threadId, response.items);
          if (response.lastLayerUsage) {
            usage = response.lastLayerUsage;
            hub.publish({
              type: 'layer_usage',
              usage,
            });
          }
          hub.publish({
            type: 'preview_invalidated',
          });
        })
        .catch((err) => {
          console.error('[inspector] turn failed:', err);
        })
        .finally(() => {
          inFlight = false;
        });
    },
  };
}

//#endregion

//#region Layer state

/** Live state if this child has run a turn; otherwise fall back to the
 *  durable mirror so layer tabs are populated right after a hot reload. */
async function readLayerState(boot: AgentBoot, layerId: string): Promise<LayerStateResult> {
  const executionId = boot.execIds.currentExecutionId(layerId);
  if (executionId !== undefined) {
    return {
      layerId,
      executionId,
      source: 'live',
      state: boot.harness.getLayerState(executionId, layerId),
    };
  }
  const keys = await boot.storage.list(`layers/${layerId}/`);
  const stateKey = keys.find((key) => key.endsWith('/state'));
  if (stateKey === undefined) {
    return {
      layerId,
      source: 'none',
      state: undefined,
    };
  }
  return {
    layerId,
    source: 'storage',
    state: await boot.storage.get(stateKey),
  };
}

//#endregion

//#region Trace serialization

function toWireSpans(boot: AgentBoot): WireSpan[] {
  return boot.exporter.spans.map((span) => ({
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? undefined,
    name: span.name,
    startTime: span.startTime,
    endTime: span.endTime ?? undefined,
    attributes: Object.fromEntries(span.attributes),
    events: span.events.map((event) => ({
      name: event.name,
      attributes: event.attributes,
    })),
  }));
}

//#endregion

//#region Server

type RouteHandler = (request: Request) => Response | Promise<Response>;

async function main(): Promise<void> {
  const env = EnvSchema.parse(process.env);
  const cfg = {
    agentFile: env.INSPECTOR_AGENT_FILE,
    dataDir: env.INSPECTOR_DATA_DIR,
    threadId: env.INSPECTOR_THREAD_ID,
  };

  const hub = createSseHub();
  const boot = await bootAgent(cfg, hub);
  const turns = createTurnWatcher(boot, cfg.threadId, hub);

  const routes: Record<string, RouteHandler> = {
    'POST /chat': async (request) => {
      const parsed = ChatRequestSchema.safeParse(await request.json());
      if (!parsed.success) {
        return jsonResponse(
          {
            error: parsed.error.message,
          },
          400,
        );
      }
      const { text, messageId, deliveryMode } = parsed.data;
      await boot.harness.execute(text, {
        threadId: cfg.threadId,
        messageId,
        deliveryMode,
      });
      // The item stream carries the user message itself (item_appended fires
      // when the turn picks it up) — no echo needed here.
      turns.watch();
      return jsonResponse(
        {
          queued: true,
        },
        202,
      );
    },

    'POST /abort': async () => {
      await boot.harness.abort({
        threadId: cfg.threadId,
        reason: 'user abort',
      });
      return jsonResponse({
        aborted: true,
      });
    },

    'GET /status': () =>
      jsonResponse(
        boot.harness.getStatus({
          threadId: cfg.threadId,
        }),
      ),

    'GET /history': async () =>
      jsonResponse({
        items: await boot.sessionStore.readItems(cfg.threadId),
      }),

    'GET /stream': () => hub.response(),

    'GET /layers': () => jsonResponse(boot.layers),

    'GET /preview': async () => {
      if (
        boot.harness.getStatus({
          threadId: cfg.threadId,
        }).kind !== 'idle'
      ) {
        return jsonResponse(
          {
            error: 'preview unavailable while generating',
          },
          409,
        );
      }
      const items = await boot.suppressed(() =>
        boot.harness.previewRequestItems({
          threadId: cfg.threadId,
        }),
      );
      return jsonResponse({
        items,
      });
    },

    'GET /usage': () => {
      const usage = turns.lastUsage();
      return usage
        ? jsonResponse(usage)
        : jsonResponse(
            {
              error: 'no turn recorded yet',
            },
            404,
          );
    },

    'GET /trace': () =>
      jsonResponse({
        spans: toWireSpans(boot),
      }),
  };

  Bun.serve({
    port: env.INSPECTOR_CHILD_PORT,
    idleTimeout: 240,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS,
        });
      }

      const layerStateMatch = url.pathname.match(/^\/layers\/([^/]+)\/state$/);
      if (layerStateMatch?.[1] !== undefined && request.method === 'GET') {
        return jsonResponse(await readLayerState(boot, decodeURIComponent(layerStateMatch[1])));
      }

      const handler = routes[`${request.method} ${url.pathname}`];
      if (!handler) {
        return jsonResponse(
          {
            error: 'not found',
          },
          404,
        );
      }
      return handler(request);
    },
  });

  console.log(
    `[inspector] agent child ready on http://localhost:${env.INSPECTOR_CHILD_PORT} (thread ${cfg.threadId})`,
  );
}

main().catch((err) => {
  // The host tails stderr into the UI's error overlay — make the failure loud.
  console.error('[inspector] agent child failed to boot:');
  console.error(err);
  process.exit(1);
});

//#endregion
