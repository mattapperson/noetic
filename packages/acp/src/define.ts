/**
 * `defineAcpAgent` — the one-call constructor behind every agent preset.
 *
 * Under ACP an "adapter" is just a way to reach a JSON-RPC peer, so an agent is
 * fully described by its id plus a transport factory. Everything else — the
 * handshake, sessions, prompts, permissions, terminals — is protocol-generic
 * and lives in {@link openAcpConnection}.
 */

import type {
  AcpAgent,
  AcpAgentConnection,
  AcpConnectOptions,
  AcpTransportFactory,
} from '@noetic-tools/types';
import { AcpCapabilityError } from '@noetic-tools/types';
import { openAcpConnection } from './connection';
import type { AcpToolWiring, ToolBridge } from './tool-bridge';
import { startToolBridge } from './tool-bridge';

/** @public Options for {@link defineAcpAgent}. */
export interface DefineAcpAgentOptions {
  /**
   * Stable identifier used for registry lookup, observability, and error
   * messages. Free-form — the set of agents is open.
   */
  agentId: string;
  /** Opens the duplex byte stream to the agent. */
  transport: AcpTransportFactory;
  /** Environment layered onto every connection this agent opens. */
  env?: Record<string, string | undefined>;
  /**
   * How this agent takes Noetic tools over MCP. Omit for an agent that cannot
   * reach a loopback server, or ignores the MCP servers it is given.
   */
  tools?: AcpToolWiring;
}

/** @public Build an {@link AcpAgent} from a transport factory. */
export function defineAcpAgent(def: DefineAcpAgentOptions): AcpAgent {
  return {
    specificationVersion: 'acp-v1',
    agentId: def.agentId,
    servesTools: def.tools !== undefined,
    async connect(opts: AcpConnectOptions): Promise<AcpAgentConnection> {
      const signal = opts.signal ?? opts.host.signal;
      const bridge = await openBridge(def, opts);
      try {
        const transport = await def.transport({
          cwd: opts.host.cwd,
          env: {
            ...def.env,
            ...bridge?.env,
          },
          signal,
        });
        return await openAcpConnection({
          agentId: def.agentId,
          transport,
          host: opts.host,
          signal,
          tools: bridge,
        });
      } catch (e) {
        await bridge?.close();
        throw e;
      }
    },
  };
}

/** Start the tool bridge when the step gave tools, before the agent spawns. */
async function openBridge(
  def: DefineAcpAgentOptions,
  opts: AcpConnectOptions,
): Promise<ToolBridge | undefined> {
  const host = opts.host.tools;
  if (!host) {
    return undefined;
  }
  if (!def.tools) {
    throw new AcpCapabilityError({
      agentId: def.agentId,
      capability: 'tools',
      message: `ACP agent '${def.agentId}' cannot take Noetic tools: it does not use the MCP servers it is given, or cannot reach one on this machine.`,
    });
  }
  return await startToolBridge({
    wiring: def.tools,
    getHost: () => opts.host.tools,
    serverName: host.serverName,
    tools: host.tools,
    mcpServers: opts.mcpServers ?? [],
    env: def.env,
  });
}
