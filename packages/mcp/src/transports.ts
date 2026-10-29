/**
 * Building the MCP transport for a target: stdio subprocess, Streamable HTTP,
 * the deprecated HTTP+SSE transport (loaded only when asked for), or a
 * caller-built transport.
 *
 * Configured HTTP headers never follow a redirect to another origin. Plain
 * `fetch` re-sends custom headers to the redirect target; the origin-aware
 * fetch below follows redirects manually and drops the configured headers
 * when the origin changes, as Agent Plugins §7.2.1 requires.
 */

import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpFetch, McpHttpServer, McpServerTarget } from './config';
import { isStdioTarget, isTransportTarget } from './config';
import { createSseTransport } from './sse-transport';

//#region Origin-aware fetch

/** Redirect hops to follow before giving up, matching the fetch default. */
const MAX_REDIRECTS = 20;

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400 && response.headers.has('location');
}

function becomesGet(status: number, method: string | undefined): boolean {
  return status === 303 || ((status === 301 || status === 302) && method === 'POST');
}

/**
 * @public
 * A `fetch` that drops `configured` headers when a redirect crosses an origin.
 * Same-origin redirects keep them; a 303 (or a 301/302 on a POST) becomes a
 * bodyless GET.
 */
export function originAwareFetch(
  configured: Readonly<Record<string, string>>,
  base: McpFetch = fetch,
): McpFetch {
  const configuredNames = Object.keys(configured).map((name) => name.toLowerCase());
  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    let url = new URL(input);
    const origin = url.origin;
    let headers = new Headers(init?.headers);
    const request: RequestInit = {
      ...init,
    };
    for (let hop = 0; ; hop++) {
      const response = await base(url, {
        ...request,
        headers,
        redirect: 'manual',
      });
      if (!isRedirect(response) || hop >= MAX_REDIRECTS) {
        return response;
      }
      url = new URL(response.headers.get('location') ?? '', url);
      if (url.origin !== origin) {
        const stripped = new Headers(headers);
        for (const name of configuredNames) {
          stripped.delete(name);
        }
        headers = stripped;
      }
      if (becomesGet(response.status, request.method)) {
        request.method = 'GET';
        request.body = undefined;
      }
    }
  };
}

//#endregion

//#region Public API

async function createHttpTransport(target: McpHttpServer): Promise<Transport> {
  const url = new URL(target.url);
  const headers = {
    ...(target.headers ?? {}),
  };
  const guarded = originAwareFetch(headers, target.fetch);
  const requestInit =
    Object.keys(headers).length === 0
      ? undefined
      : {
          headers,
        };
  if (target.protocol === 'sse') {
    return createSseTransport(url, requestInit, guarded);
  }
  return new StreamableHTTPClientTransport(url, {
    fetch: guarded,
    ...(requestInit === undefined
      ? {}
      : {
          requestInit,
        }),
  });
}

/** @public Builds a fresh transport for one MCP session. */
export async function createTransport(target: McpServerTarget): Promise<Transport> {
  if (isTransportTarget(target)) {
    return target.transport();
  }
  if (isStdioTarget(target)) {
    return new StdioClientTransport({
      command: target.command,
      args: [
        ...(target.args ?? []),
      ],
      ...(target.env === undefined
        ? {}
        : {
            env: {
              ...target.env,
            },
          }),
      ...(target.cwd === undefined
        ? {}
        : {
            cwd: target.cwd,
          }),
    });
  }
  return createHttpTransport(target);
}

//#endregion
