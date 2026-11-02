/**
 * Serves a step's Noetic tools to the agent over MCP, configured so the
 * agent's model sees them exactly as a `callModel` model would.
 *
 * Out of the box agents hide MCP tools behind a search or code step, cut large
 * results, and run their own approval review. Each preset's
 * {@link AcpToolWiring} turns those off. Some agents only read those settings
 * at launch, so the bridge starts before the agent process does.
 */

import type { AcpMcpServer, AcpTool, AcpToolHost } from '@noetic-tools/types';

//#region Types

/** @public Where a running bridge can be reached. */
export interface ToolBridgeAddress {
  readonly serverName: string;
  readonly url: string;
  readonly headers: ReadonlyArray<{
    name: string;
    value: string;
  }>;
}

/** @public What a preset's launch settings are built from. */
export interface ToolBridgeLaunch {
  readonly bridge: ToolBridgeAddress;
  readonly tools: ReadonlyArray<AcpTool>;
  /** The user's own MCP servers for the session. */
  readonly mcpServers: ReadonlyArray<AcpMcpServer>;
  /** The preset's environment, to merge into rather than replace. */
  readonly env: Record<string, string | undefined>;
}

/**
 * How one agent takes the bridge.
 * @public
 */
export interface AcpToolWiring {
  /**
   * `'session'`: the bridge joins the `session/new` MCP servers.
   * `'launch'`: `launchEnv` declares every MCP server — the bridge and the
   * user's own — and `session/new` carries none. For agents that drop
   * per-server settings from servers given in `session/new`.
   */
  readonly declare: 'session' | 'launch';
  /** Environment for the agent process that switches its tool handling to match `callModel`. */
  launchEnv?(launch: ToolBridgeLaunch): Record<string, string>;
}

/** A running bridge, owned by one connection. */
export interface ToolBridge {
  readonly declare: AcpToolWiring['declare'];
  /** The MCP server entry for `session/new`. */
  readonly server: AcpMcpServer;
  readonly env: Record<string, string>;
  close(): Promise<void>;
}

//#endregion

//#region Public API

/**
 * Start the loopback MCP server and work out the agent's launch settings.
 * The node-only server module loads on first use, so the package's main entry
 * stays runtime-neutral.
 */
export async function startToolBridge(opts: {
  wiring: AcpToolWiring;
  getHost: () => AcpToolHost | undefined;
  serverName: string;
  tools: ReadonlyArray<AcpTool>;
  mcpServers: ReadonlyArray<AcpMcpServer>;
  env?: Record<string, string | undefined>;
}): Promise<ToolBridge> {
  const { serveToolsOverHttp } = await import('@noetic-tools/mcp/node');
  const http = await serveToolsOverHttp(opts.getHost);
  const bridge: ToolBridgeAddress = {
    serverName: opts.serverName,
    url: http.url,
    headers: [
      {
        name: 'Authorization',
        value: `Bearer ${http.token}`,
      },
    ],
  };
  let env: Record<string, string>;
  try {
    env =
      opts.wiring.launchEnv?.({
        bridge,
        tools: opts.tools,
        mcpServers: opts.mcpServers,
        env: opts.env ?? {},
      }) ?? {};
  } catch (e) {
    await http.close();
    throw e;
  }
  return {
    declare: opts.wiring.declare,
    server: {
      type: 'http',
      name: bridge.serverName,
      url: bridge.url,
      headers: [
        ...bridge.headers,
      ],
    },
    env,
    close: () => http.close(),
  };
}

//#endregion
