/**
 * In-memory duplex transport pair.
 *
 * Wires a Noetic ACP client directly to an `AgentSideConnection` running in the
 * same process. Tests therefore exercise the **real** JSON-RPC wire protocol in
 * both directions — capability negotiation, session updates, permission
 * round-trips, `fs/*` and `terminal/*` callbacks — without spawning a process.
 */

import type { AcpTransport, AcpTransportFactory } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import type * as acp from '@zed-industries/agent-client-protocol';
import { AgentSideConnection, ndJsonStream } from '@zed-industries/agent-client-protocol';

/** @public The two ends of a loopback connection. */
export interface AcpLoopbackPair {
  /** Give this to `openAcpConnection`. */
  client: AcpTransport;
  /** Give this to an `AgentSideConnection`. */
  agent: AcpTransport;
}

function endpoint(
  readable: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
): AcpTransport {
  let closed = false;
  return {
    readable,
    writable,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      // The peer's readable ends when this writable closes, which is how each
      // side learns the connection is gone.
      await writable.close().catch(() => undefined);
    },
  };
}

/** @public Create a connected pair of in-memory transports. */
export function createAcpLoopbackPair(): AcpLoopbackPair {
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    client: endpoint(agentToClient.readable, clientToAgent.writable),
    agent: endpoint(clientToAgent.readable, agentToClient.writable),
  };
}

/**
 * A transport factory that stands an in-process ACP agent on the far end.
 *
 * Pair it with {@link defineAcpAgent} to get an {@link AcpAgent} that behaves
 * exactly like a spawned one — full handshake, sessions, notifications,
 * client callbacks — with no process and no network. This is the recommended
 * way to test an ACP-backed step.
 *
 * @public
 */
export function loopbackTransport(
  toAgent: (conn: AgentSideConnection) => acp.Agent,
): AcpTransportFactory {
  return async (): Promise<AcpTransport> => {
    const pair = createAcpLoopbackPair();
    let agent: acp.Agent | undefined;
    // The connection registers its own message pump on construction; holding
    // the reference keeps it alive for the life of the transport.
    const connection = new AgentSideConnection(
      (conn) => {
        agent = toAgent(conn);
        return agent;
      },
      ndJsonStream(pair.agent.writable, pair.agent.readable),
    );
    return {
      readable: pair.client.readable,
      writable: pair.client.writable,
      async close() {
        void connection;
        await pair.client.close();
        // A served Noetic agent (and any agent following the same shape)
        // exposes dispose() to cancel its live sessions; without this, the
        // in-process path would leave sessions running after the client is
        // gone — only the stdio entry's stdin handlers would ever clean up.
        const disposable = frameworkCast<{
          dispose?: () => Promise<void>;
        }>(agent);
        if (typeof disposable?.dispose === 'function') {
          await disposable.dispose().catch(() => undefined);
        }
      },
    };
  };
}
