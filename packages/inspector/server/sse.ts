/**
 * Minimal SSE fan-out plus the JSON conventions shared by both servers:
 * `data: <json>\n\n` framing (openui-airbnb precedent) with a retry hint and
 * periodic ping comments so idle connections stay alive, and a Map/Set-safe
 * stringify (the filesystem layer's state holds a `Map`).
 */

const PING_INTERVAL_MS = 15e3;
const ENCODER = new TextEncoder();

export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

//#region JSON helpers

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return {
      __type: 'Map',
      entries: [
        ...value.entries(),
      ],
    };
  }
  if (value instanceof Set) {
    return {
      __type: 'Set',
      values: [
        ...value.values(),
      ],
    };
  }
  if (typeof value === 'bigint') {
    return String(value);
  }
  return value;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, jsonReplacer);
}

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(toJson(value), {
    status,
    headers: {
      'content-type': 'application/json',
      ...CORS_HEADERS,
    },
  });
}

//#endregion

//#region SSE hub

export interface SseHub {
  response(): Response;
  publish(frame: unknown): void;
  close(): void;
}

export function createSseHub(): SseHub {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

  const ping = setInterval(() => {
    broadcast(ENCODER.encode(': ping\n\n'));
  }, PING_INTERVAL_MS);

  function broadcast(bytes: Uint8Array): void {
    for (const controller of clients) {
      try {
        controller.enqueue(bytes);
      } catch {
        clients.delete(controller);
      }
    }
  }

  return {
    response(): Response {
      let self: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          self = controller;
          clients.add(controller);
          controller.enqueue(ENCODER.encode('retry: 1000\n\n'));
        },
        cancel() {
          clients.delete(self);
        },
      });
      return new Response(body, {
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          ...CORS_HEADERS,
        },
      });
    },

    publish(frame: unknown): void {
      broadcast(ENCODER.encode(`data: ${toJson(frame)}\n\n`));
    },

    close(): void {
      clearInterval(ping);
      for (const controller of clients) {
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      }
      clients.clear();
    },
  };
}

//#endregion
