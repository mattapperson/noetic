/**
 * `defineAcpAgent` — the one-call constructor behind every agent preset.
 *
 * Under ACP an "adapter" is just a way to reach a JSON-RPC peer, so an agent is
 * fully described by its id plus how to start it (a command, run through a
 * subprocess adapter) or
 * attach to it (a transport). Everything else — the handshake, sessions,
 * prompts, permissions, terminals — is protocol-generic and lives in
 * {@link openAcpConnection}.
 */

import type {
  AcpAgent,
  AcpAgentConnection,
  AcpConnectOptions,
  AcpReattachHandle,
  AcpToolRefusal,
  AcpTransport,
  AcpTransportFactory,
  AcpWhenHostExits,
  SpawnCommand,
  SubprocessAdapter,
  SubprocessChoice,
  SubprocessLink,
  ToolBridgeAddress,
} from '@noetic-tools/types';
import { AcpConnectError, NoeticConfigError } from '@noetic-tools/types';
import { z } from 'zod';
import type { InstructionsMeta } from './connection';
import { openAcpConnection } from './connection';
import { cannotOpen, openLink, spawnOn } from './spawn';
import type { AcpToolWiring, ToolBridge, ToolBridgeCredentials } from './tool-bridge';
import { startToolBridge } from './tool-bridge';
import { sessionToolWiring } from './tool-wiring';
import type { TurnUsageOf } from './turn-usage';

//#region Types

/** @public Options for {@link defineAcpAgent}. */
export interface DefineAcpAgentOptions {
  /**
   * Stable identifier used for registry lookup, observability, and error
   * messages. Free-form — the set of agents is open.
   */
  agentId: string;
  /** Starts the agent: this command, run through {@link subprocess}. */
  command?: SpawnCommand;
  /**
   * Where {@link command} runs: an adapter, or the name of one of the
   * harness's `environment.subprocess` adapters. A step's own `subprocess`
   * name comes first. Without either it runs through the harness's default.
   * The adapter it lands on must have `open`.
   */
  subprocess?: SubprocessAdapter | string;
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
  /**
   * How this agent takes a step's `instructions` when it does not advertise
   * `sessionCapabilities.systemPrompt`: the `_meta` to send instead. Without
   * one, such instructions are refused (spec 27 § Instructions).
   */
  instructionsMeta?: InstructionsMeta;
  /**
   * This agent's own session options, sent as `_meta` on every session it
   * opens (Claude Code's `{ claudeCode: { options } }`). Vendor options live
   * here, never on a step.
   */
  sessionMeta?: Readonly<Record<string, unknown>>;
  /**
   * Which of this agent's own tools a call is to, from its update: becomes
   * the call's `toolId` / `toolServer`. Without one, a call goes by its title.
   */
  toolIdOf?: AcpAgent['toolIdOf'];
  /**
   * The tokens a turn cost, from the agent's answer to it. ACP's `usage` is
   * the session's running total, so without one no turn is charged; set it
   * for a bridge that reports each turn's own figures.
   */
  usageOf?: TurnUsageOf;
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
    ...(def.command && typeof def.subprocess === 'string'
      ? {
          subprocess: def.subprocess,
        }
      : {}),
    refusesTools: def.command ? undefined : attachedRefusal(def.tools ?? sessionToolWiring),
    spawn: def.command
      ? (command, options) => spawnOn(subprocessOf(def, options?.subprocess))(command)
      : undefined,
    ...(def.toolIdOf
      ? {
          toolIdOf: def.toolIdOf,
        }
      : {}),
    async connect(opts: AcpConnectOptions): Promise<AcpAgentConnection> {
      const signal = opts.signal ?? opts.host.signal;
      const whenHostExits = opts.whenHostExits ?? 'keep';
      if (opts.reattach) {
        return await reattachTo(def, opts, opts.reattach);
      }
      const opened = await openTarget(def, {
        cwd: opts.host.cwd,
        signal,
        whenHostExits,
        subprocess: opts.subprocess,
      });
      let bridge: ToolBridge | undefined;
      try {
        bridge = await openBridge(def, opts, {
          reach: opened.reach,
        });
        const transport = await opened.open(bridge?.env ?? {});
        return await openAcpConnection({
          agentId: def.agentId,
          transport: closingWith(transport, opened),
          host: opts.host,
          signal,
          tools: bridge,
          instructionsMeta: def.instructionsMeta,
          sessionMeta: def.sessionMeta,
          usageOf: def.usageOf,
          reattach: reattachHandle(transport.reattach, bridge),
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
    'Give the agent a command and a subprocess adapter instead of a `transport` — `createWebSocketSubprocessAdapter()` or `createCommandSubprocessAdapter()` from @noetic-tools/platform-node reach a remote runner (`noetic-acp serve`) — or leave `tools` off this step.';
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

/** A command starts through its subprocess adapter; a transport attaches as it is. */
async function openTarget(
  def: DefineAcpAgentOptions,
  {
    cwd,
    signal,
    whenHostExits,
    subprocess: given,
  }: {
    cwd: string;
    signal: AbortSignal | undefined;
    whenHostExits: AcpWhenHostExits;
    subprocess: SubprocessChoice | undefined;
  },
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
          whenHostExits,
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
  const link = await openLink(
    subprocessOf(def, given),
    {
      signal,
      whenHostExits,
    },
    `ACP agent '${def.agentId}'`,
  );
  return {
    open: (env) =>
      link.launch({
        ...command,
        cwd,
        env: {
          ...def.env,
          ...command.env,
          ...env,
        },
      }),
    reach: (bridge) => link.reach(bridge),
    close: () => link.close(),
  };
}

/**
 * Where a command agent runs: the adapter the step names, else the agent's
 * own (an adapter, or a name), else the harness's default. A name is one of
 * the harness's adapters.
 *
 * @throws `NoeticConfigError` `ADAPTER_UNKNOWN` for a name the harness lacks,
 * `SUBPROCESS_NAME_WITHOUT_HARNESS` for a named adapter with no harness set
 * to find it in, `SUBPROCESS_CANNOT_OPEN` when no adapter is given at all.
 */
function subprocessOf(
  def: DefineAcpAgentOptions,
  given: SubprocessChoice | undefined,
): SubprocessAdapter {
  const own = def.subprocess;
  const name = given?.name ?? (typeof own === 'string' ? own : undefined);
  if (name !== undefined) {
    if (!given) {
      throw new NoeticConfigError({
        code: 'SUBPROCESS_NAME_WITHOUT_HARNESS',
        message: `ACP agent '${def.agentId}' names the subprocess adapter '${name}', and was given no harness adapters to find it among.`,
        hint: 'Run the agent as a step, so the harness passes its `environment.subprocess`, or give the agent the adapter itself.',
      });
    }
    return given.adapters.get(name);
  }
  if (typeof own === 'object') {
    return own;
  }
  if (!given) {
    throw cannotOpen(
      `ACP agent '${def.agentId}' has no subprocess adapter to start its command through.`,
    );
  }
  return given.adapters.get();
}

/** Closing the agent's stream closes the link it was started through. */
function closingWith(transport: AcpTransport, opened: Opened): AcpTransport {
  const detach = transport.detach?.bind(transport);
  return {
    readable: transport.readable,
    writable: transport.writable,
    ...(transport.reattach
      ? {
          reattach: transport.reattach,
        }
      : {}),
    async close() {
      try {
        await transport.close();
      } finally {
        await opened.close();
      }
    },
    // Letting go keeps the link open: closing it would stop the agent a later host reattaches to.
    ...(detach
      ? {
          detach,
        }
      : {}),
  };
}

/**
 * Reach the agent an earlier host started, through the adapter that runs it:
 * the stream from its keeper, and the bridge served again under the path and
 * token the agent was given, at the address it already uses.
 */
async function reattachTo(
  def: DefineAcpAgentOptions,
  opts: AcpConnectOptions,
  handle: AcpReattachHandle,
): Promise<AcpAgentConnection> {
  const signal = opts.signal ?? opts.host.signal;
  const whenHostExits = opts.whenHostExits ?? 'keep';
  if (!def.command) {
    throw new AcpConnectError({
      agentId: def.agentId,
      message: `ACP agent '${def.agentId}' attaches through a transport and cannot be reattached.`,
    });
  }
  const link = await openLink(
    subprocessOf(def, opts.subprocess),
    {
      signal,
      whenHostExits,
    },
    `ACP agent '${def.agentId}'`,
  );
  let bridge: ToolBridge | undefined;
  let attached: AcpTransport | undefined;
  try {
    if (!link.attach) {
      throw new AcpConnectError({
        agentId: def.agentId,
        message: `The subprocess adapter ACP agent '${def.agentId}' runs through cannot reattach to an agent.`,
      });
    }
    const transport = await link.attach(handle);
    attached = transport;
    bridge = await openBridge(def, opts, {
      reach: (address) => link.reach(address),
      reuse: bridgeOf(handle),
    });
    return await openAcpConnection({
      agentId: def.agentId,
      transport: closingWith(transport, {
        open: async () => transport,
        reach: (address) => link.reach(address),
        close: () => link.close(),
      }),
      host: opts.host,
      signal,
      tools: bridge,
      instructionsMeta: def.instructionsMeta,
      sessionMeta: def.sessionMeta,
      usageOf: def.usageOf,
      reattach: reattachHandle(transport.reattach ?? handle, bridge),
      reattached: true,
    });
  } catch (e) {
    await bridge?.close();
    await letGoOf(attached, link);
    throw e;
  }
}

/**
 * A reattach that failed before this host adopted the agent: let go of it, so
 * it keeps running for a host that can — never stop it. Only a link that
 * reached nothing is closed.
 */
async function letGoOf(attached: AcpTransport | undefined, link: SubprocessLink): Promise<void> {
  if (attached?.detach) {
    await attached.detach().catch(() => undefined);
    return;
  }
  await link.close().catch(() => undefined);
}

const BridgeCredentialsSchema = z.object({
  path: z.string().startsWith('/'),
  token: z.string().min(1),
});

/** The bridge credentials a reattach handle carries, if any. */
function bridgeOf(handle: AcpReattachHandle): ToolBridgeCredentials | undefined {
  const parsed = BridgeCredentialsSchema.safeParse(handle.bridge);
  return parsed.success ? parsed.data : undefined;
}

/** The handle a later host reattaches with: the link's, plus the bridge it must serve again. */
function reattachHandle(
  handle: AcpReattachHandle | undefined,
  bridge: ToolBridge | undefined,
): AcpReattachHandle | undefined {
  if (!handle) {
    return undefined;
  }
  return bridge
    ? {
        ...handle,
        bridge: bridge.credentials,
      }
    : handle;
}

/** Start the tool bridge when the step gave tools, before the agent starts. */
async function openBridge(
  def: DefineAcpAgentOptions,
  opts: AcpConnectOptions,
  {
    reach,
    reuse,
  }: {
    reach: Opened['reach'];
    /** Serve under what an earlier host gave a reattached agent. */
    reuse?: ToolBridgeCredentials;
  },
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
    reuse,
  });
}

//#endregion
