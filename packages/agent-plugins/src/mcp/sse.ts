/**
 * Construction of the deprecated HTTP+SSE client transport, isolated here.
 *
 * §7.2.1 makes `sse` support OPTIONAL and it is off by default (see
 * `DEFAULT_TRANSPORTS`), so a host that never opts into the 2024-11-05
 * transport should not pay to load it. Reaching it through a dynamic
 * `import()` from its own module keeps it out of the graph until an `sse`
 * entry is actually connected.
 *
 * Keeping it in a file of its own also disambiguates the specifier for
 * suffix-matching import resolvers: `sentrux` otherwise resolves
 * `@modelcontextprotocol/sdk/client/sse.js` to the only in-repo `sse.ts`,
 * which is `packages/inspector/server/sse.ts`, and reports a dependency on
 * the inspector package that does not exist.
 */

import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/** @public Fixed headers to send when connecting to the configured origin. */
export interface SseRequestInit {
  headers: Record<string, string>;
}

/** @public Build an HTTP+SSE client transport for a remote MCP endpoint. */
export async function createSseTransport(
  url: URL,
  requestInit: SseRequestInit | undefined,
  /** Origin-aware fetch, so a redirect cannot carry configured headers off-origin. */
  fetchImpl?: FetchLike,
): Promise<Transport> {
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
  return new SSEClientTransport(url, {
    ...(fetchImpl === undefined
      ? {}
      : {
          fetch: fetchImpl,
        }),
    ...(requestInit === undefined
      ? {}
      : {
          requestInit,
        }),
  });
}
