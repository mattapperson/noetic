/**
 * The deprecated HTTP+SSE client transport (MCP 2024-11-05), isolated and
 * loaded through a dynamic `import()` so a host that never connects an SSE
 * server does not load it.
 *
 * The file is deliberately not named `sse.ts`: suffix-matching import
 * resolvers (sentrux) would otherwise resolve
 * `@modelcontextprotocol/sdk/client/sse.js` to it.
 */

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { McpFetch } from './config';

/** @public What both HTTP transports are built with. */
export interface HttpTransportOptions {
  readonly fetch: McpFetch;
  readonly requestInit?: {
    readonly headers: Record<string, string>;
  };
  readonly authProvider?: OAuthClientProvider;
}

/** @public Builds an HTTP+SSE client transport for a remote MCP endpoint. */
export async function createSseTransport(
  url: URL,
  options: HttpTransportOptions,
): Promise<Transport> {
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
  return new SSEClientTransport(url, options);
}
