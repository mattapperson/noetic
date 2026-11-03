/**
 * Serves a step's Noetic tools to the agent over MCP, configured so the
 * agent's model sees them exactly as a `callModel` model would.
 *
 * Out of the box agents hide MCP tools behind a search or code step, cut large
 * results, and run their own approval review. Each preset's
 * {@link AcpToolWiring} turns those off. Some agents only read those settings
 * at launch, so the bridge starts before the agent process does.
 */

import type { AcpMcpServer, AcpTool, AcpToolHost, ToolBridgeAddress } from '@noetic-tools/types';
import type { BridgedPermissionCheck } from './tool-permissions';

export type { ToolBridgeAddress } from '@noetic-tools/types';

//#region Types

/** @public What a preset's launch settings are built from. */
export interface ToolBridgeLaunch {
  /** The bridge as the agent reaches it, from its own machine. */
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
  /**
   * Recognizes this agent's permission requests for bridged tools, which are
   * then allowed. Without one, every request goes to the step's policy.
   */
  readonly permits?: BridgedPermissionCheck;
}

/** A running bridge, owned by one connection. */
export interface ToolBridge {
  readonly declare: AcpToolWiring['declare'];
  /** The MCP server entry for `session/new`. */
  readonly server: AcpMcpServer;
  readonly env: Record<string, string>;
  readonly permits?: BridgedPermissionCheck;
  close(): Promise<void>;
}

//#endregion

//#region Public API

/**
 * Start the loopback MCP server, carry it to the agent's machine, and work
 * out the agent's launch settings from the address it reaches there. The
 * node-only server module loads on first use, so the package's main entry
 * stays runtime-neutral.
 */
export async function startToolBridge(opts: {
  wiring: AcpToolWiring;
  getHost: () => AcpToolHost | undefined;
  serverName: string;
  tools: ReadonlyArray<AcpTool>;
  mcpServers: ReadonlyArray<AcpMcpServer>;
  env?: Record<string, string | undefined>;
  /** Carries the bridge to the agent's machine; this machine's loopback by default. */
  reach?: (bridge: ToolBridgeAddress) => Promise<ToolBridgeAddress>;
}): Promise<ToolBridge> {
  const { serveToolsOverHttp } = await import('./mcp/node');
  const http = await serveToolsOverHttp(opts.getHost);
  const local: ToolBridgeAddress = {
    serverName: opts.serverName,
    url: http.url,
    headers: [
      {
        name: 'Authorization',
        value: `Bearer ${http.token}`,
      },
    ],
  };
  let bridge: ToolBridgeAddress;
  let env: Record<string, string>;
  try {
    bridge = opts.reach ? await opts.reach(local) : local;
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
    permits: opts.wiring.permits,
    close: () => http.close(),
  };
}

//#endregion
