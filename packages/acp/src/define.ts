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
import { openAcpConnection } from './connection';

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
}

/** @public Build an {@link AcpAgent} from a transport factory. */
export function defineAcpAgent(def: DefineAcpAgentOptions): AcpAgent {
  return {
    specificationVersion: 'acp-v1',
    agentId: def.agentId,
    async connect(opts: AcpConnectOptions): Promise<AcpAgentConnection> {
      const transport = await def.transport({
        cwd: opts.host.cwd,
        env: def.env,
        signal: opts.signal ?? opts.host.signal,
      });
      return await openAcpConnection({
        agentId: def.agentId,
        transport,
        host: opts.host,
        signal: opts.signal ?? opts.host.signal,
      });
    },
  };
}
