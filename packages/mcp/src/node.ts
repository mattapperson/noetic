/**
 * Serves a tool host over MCP streamable HTTP on the loopback interface.
 *
 * Lives behind the `@noetic-tools/mcp/node` subpath because it needs
 * `node:http`; the package's main entry stays runtime-neutral.
 *
 * Any local process can reach a loopback port, so every request must carry
 * the server's bearer token, name it by its own host, and come from no web
 * origin (the MCP spec's guard against DNS rebinding).
 */

import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AcpToolHost } from '@noetic-tools/types';
import { createToolServer } from './server';

//#region Types

/** @public Where an agent reaches a running tool server. */
export interface HttpToolServer {
  /** Full endpoint URL, path included. */
  readonly url: string;
  /** Sent by the agent as `Authorization: Bearer <token>`. */
  readonly token: string;
  close(): Promise<void>;
}

//#endregion

//#region Request guard

function allowedHosts(port: number): ReadonlySet<string> {
  return new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
  ]);
}

function pathOf(url: string | undefined): string {
  return new URL(url ?? '/', 'http://127.0.0.1').pathname;
}

function sameSecret(given: string | undefined, expected: string): boolean {
  const a = Buffer.from(given ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The status to refuse a request with, or `undefined` to let it through. */
function refusal(
  req: IncomingMessage,
  expect: {
    path: string;
    token: string;
    hosts: ReadonlySet<string>;
  },
): number | undefined {
  if (pathOf(req.url) !== expect.path) {
    return 404;
  }
  if (!sameSecret(req.headers.authorization, `Bearer ${expect.token}`)) {
    return 401;
  }
  if (!req.headers.host || !expect.hosts.has(req.headers.host)) {
    return 403;
  }
  if (req.headers.origin !== undefined) {
    return 403;
  }
  return undefined;
}

//#endregion

//#region Public API

/**
 * Start a tool server on `127.0.0.1` at a random port and path. Each MCP
 * session the agent opens gets its own protocol server over the same host.
 * @public
 */
export async function serveToolsOverHttp(
  getHost: () => AcpToolHost | undefined,
): Promise<HttpToolServer> {
  const token = randomUUID();
  const path = `/mcp/${randomUUID()}`;
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const open = async (): Promise<StreamableHTTPServerTransport> => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };
    await createToolServer(getHost).connect(transport);
    return transport;
  };

  let hosts: ReadonlySet<string> = new Set();
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const status = refusal(req, {
      path,
      token,
      hosts,
    });
    if (status !== undefined) {
      res.writeHead(status).end();
      return;
    }
    try {
      await route(req, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500);
      }
      res.end();
    }
  });

  /**
   * A request naming a session goes to it. Only a POST may open a new one, and
   * a transport the request did not initialize is closed at once.
   */
  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const existing = sessions.get(sessionId);
      if (!existing) {
        res.writeHead(404).end();
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const transport = await open();
    await transport.handleRequest(req, res);
    if (!transport.sessionId) {
      await transport.close();
    }
  };

  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
  const address = http.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The tool server did not bind a TCP port.');
  }
  const port = address.port;
  hosts = allowedHosts(port);

  return {
    url: `http://127.0.0.1:${port}${path}`,
    token,
    async close() {
      for (const transport of sessions.values()) {
        await transport.close().catch(() => undefined);
      }
      sessions.clear();
      await new Promise<void>((resolve) => {
        http.close(() => resolve());
        http.closeAllConnections();
      });
    },
  };
}

//#endregion
