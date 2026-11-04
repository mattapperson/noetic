/**
 * `defineAcpAgent` — the one-call constructor behind every agent preset.
 *
 * Under ACP an "adapter" is just a way to reach a JSON-RPC peer, so an agent is
 * fully described by its id plus how to start it (a command on a machine) or
 * attach to it (a transport). Everything else — the handshake, sessions,
 * prompts, permissions, terminals — is protocol-generic and lives in
 * {@link openAcpConnection}.
 */

import type {
  AcpAgent,
  AcpAgentConnection,
  AcpConnectOptions,
  AcpMachine,
  AcpMachineFactory,
  AcpToolRefusal,
  AcpTransport,
  AcpTransportFactory,
  SpawnCommand,
  ToolBridgeAddress,
} from '@noetic-tools/types';
import { openAcpConnection } from './connection';
import { spawnOn } from './spawn';
import type { AcpToolWiring, ToolBridge } from './tool-bridge';
import { startToolBridge } from './tool-bridge';
import { sessionToolWiring } from './tool-wiring';

//#region Types

/** @public Options for {@link defineAcpAgent}. */
export interface DefineAcpAgentOptions {
  /**
   * Stable identifier used for registry lookup, observability, and error
   * messages. Free-form — the set of agents is open.
   */
  agentId: string;
  /** Starts the agent: this command, run on {@link machine}. */
  command?: SpawnCommand;
  /** Where {@link command} runs. This machine by default. */
  machine?: AcpMachineFactory;
  /**
   * Opens the byte stream to an agent this package does not start. Used in
   * place of `command`.
   */
  transport?: AcpTransportFactory;
  /** Environment layered onto every connection this agent opens. */
  env?: Record<string, string | undefined>;
  /**
   * How this agent takes Noetic tools. Defaults to {@link sessionToolWiring}:
   * the bridge joins `session/new` with no agent-specific settings.
   */
  tools?: AcpToolWiring;
}

/** How one connection reaches its agent: the stream, and the bridge's way there. */
interface Opened {
  open(env: Record<string, string>): Promise<AcpTransport>;
  reach(bridge: ToolBridgeAddress): Promise<ToolBridgeAddress>;
  close(): Promise<void>;
}

//#endregion

//#region Public API

/** @public Build an {@link AcpAgent} from a command or a transport factory. */
export function defineAcpAgent(def: DefineAcpAgentOptions): AcpAgent {
  if (!def.command && !def.transport) {
    throw new TypeError(
      `defineAcpAgent(${JSON.stringify(def.agentId)}) requires either a 'command' to start or a 'transport'.`,
    );
  }
  return {
    specificationVersion: 'acp-v1',
    agentId: def.agentId,
    refusesTools: def.command ? undefined : attachedRefusal(def.tools ?? sessionToolWiring),
    spawn: def.command ? spawnOn(def.machine ?? lazyLocalMachine(def.agentId)) : undefined,
    async connect(opts: AcpConnectOptions): Promise<AcpAgentConnection> {
      const signal = opts.signal ?? opts.host.signal;
      const opened = await openTarget(def, opts.host.cwd, signal);
      let bridge: ToolBridge | undefined;
      try {
        bridge = await openBridge(def, opts, opened.reach);
        const transport = await opened.open(bridge?.env ?? {});
        return await openAcpConnection({
          agentId: def.agentId,
          transport: closingWith(transport, opened),
          host: opts.host,
          signal,
          tools: bridge,
        });
      } catch (e) {
        await bridge?.close();
        await opened.close().catch(() => undefined);
        throw e;
      }
    },
  };
}

//#endregion

//#region Helpers

/**
 * An attached agent was started by someone else and may run anywhere, so
 * neither the bridge's loopback address nor the wiring's launch settings are
 * sure to reach it.
 */
function attachedRefusal(wiring: AcpToolWiring): AcpToolRefusal {
  const hint =
    'Give the agent a command and a `machine` instead of a `transport` — `webSocketMachine()` or `commandMachine()` from @noetic-tools/acp/remote reach a remote runner (`noetic-acp serve`) — or leave `tools` off this step.';
  if (wiring.launchEnv) {
    return {
      code: 'ACP_TRANSPORT_CANNOT_LAUNCH',
      reason:
        'it attaches through a custom `transport` to an agent someone else started, so its tool launch settings cannot be applied, and the transport has no `launch()`.',
      hint,
    };
  }
  return {
    code: 'ACP_TRANSPORT_CANNOT_REACH',
    reason:
      'it attaches through a custom `transport`, which has no `reach()` to carry the tool bridge to it.',
    hint,
  };
}

/** A command starts on its machine; a transport attaches as it is. */
async function openTarget(
  def: DefineAcpAgentOptions,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<Opened> {
  const command = def.command;
  if (!command) {
    const transport = def.transport;
    if (!transport) {
      throw new TypeError(`defineAcpAgent(${JSON.stringify(def.agentId)}) has nothing to open.`);
    }
    return {
      open: (env) =>
        transport({
          cwd,
          env: {
            ...def.env,
            ...env,
          },
          signal,
        }),
      // Unreached: a step never gives an attached agent tools (`refusesTools`).
      reach: async () => {
        throw new TypeError(
          `ACP agent '${def.agentId}' attaches through a transport and cannot reach the tool bridge.`,
        );
      },
      close: async () => undefined,
    };
  }
  const machine: AcpMachine = await (def.machine ?? lazyLocalMachine(def.agentId))({
    signal,
  });
  return {
    open: (env) =>
      machine.launch({
        ...command,
        cwd,
        env: {
          ...def.env,
          ...command.env,
          ...env,
        },
      }),
    reach: (bridge) => machine.reach(bridge),
    close: () => machine.close(),
  };
}

/**
 * Defer the `node:child_process` import until a connection is actually opened,
 * so importing `@noetic-tools/acp` in a browser or worker stays safe.
 */
function lazyLocalMachine(agentId: string): AcpMachineFactory {
  return async (opts) => {
    const { localMachine } = await import('./stdio');
    return await localMachine(agentId)(opts);
  };
}

/** Closing the agent's stream releases the machine it runs on. */
function closingWith(transport: AcpTransport, opened: Opened): AcpTransport {
  return {
    readable: transport.readable,
    writable: transport.writable,
    async close() {
      try {
        await transport.close();
      } finally {
        await opened.close();
      }
    },
  };
}

/** Start the tool bridge when the step gave tools, before the agent starts. */
async function openBridge(
  def: DefineAcpAgentOptions,
  opts: AcpConnectOptions,
  reach: Opened['reach'],
): Promise<ToolBridge | undefined> {
  const host = opts.host.tools;
  if (!host) {
    return undefined;
  }
  return await startToolBridge({
    wiring: def.tools ?? sessionToolWiring,
    getHost: () => opts.host.tools,
    serverName: host.serverName,
    tools: host.tools,
    mcpServers: opts.mcpServers ?? [],
    env: def.env,
    reach,
  });
}

//#endregion
