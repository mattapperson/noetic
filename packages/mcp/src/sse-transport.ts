/**
 * The deprecated HTTP+SSE client transport (MCP 2024-11-05), isolated and
 * loaded through a dynamic `import()` so a host that never connects an SSE
 * server does not load it.
 *
 * The file is deliberately not named `sse.ts`: suffix-matching import
 * resolvers (sentrux) would otherwise resolve
 * `@modelcontextprotocol/sdk/client/sse.js` to it.
 */

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpFetch } from './config';

/** @public Builds an HTTP+SSE client transport for a remote MCP endpoint. */
export async function createSseTransport(
  url: URL,
  requestInit:
    | {
        headers: Record<string, string>;
      }
    | undefined,
  fetchImpl: McpFetch,
): Promise<Transport> {
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
  return new SSEClientTransport(url, {
    fetch: fetchImpl,
    ...(requestInit === undefined
      ? {}
      : {
          requestInit,
        }),
  });
}
