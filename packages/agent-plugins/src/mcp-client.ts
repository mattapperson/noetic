/**
 * Connecting the MCP servers a plugin declares.
 *
 * Agent Plugins defines the *configuration* format; the Model Context Protocol
 * defines the wire behavior. The MCP client, its transports and capability
 * negotiation live in `@noetic-tools/mcp` (spec 35): this module takes the
 * resolved entries produced by `mcp-config.ts`, applies the §9.1 subprocess
 * environment, and registers each server through `mcp()` as a connection with
 * no profile — so a plugin's tools share one naming rule and one set of gates
 * with every other MCP server the harness uses, and a plugin server that
 * declares a profile gets its typed operations too.
 *
 * §7.2.2 rule 5 is the rule that shapes the error handling here — a server
 * that fails to start, connect, authenticate, or handshake must not stop the
 * client loading anything else. Every failure below becomes a diagnostic and
 * an absent session, never a thrown error.
 */

import { mkdir } from 'node:fs/promises';
import type { McpConnection, McpProvider } from '@noetic-tools/mcp';
import { createMemoryArtifactStore, mcp } from '@noetic-tools/mcp';
import type { ArtifactStore } from '@noetic-tools/types';
import { isNoeticError } from '@noetic-tools/types';
import type { ResolvedMcpServer, ResolvedStdioServer } from './mcp-config';
import { McpTransport } from './mcp-config';

//#region Types

/** @public A tool exposed by a connected MCP server. */
export interface McpToolInfo {
  /** Qualified as `<plugin>/<server>/<tool>` — unique across every connected server. */
  qualifiedName: string;
  /** The tool name as the server declares it. */
  name: string;
  /** `<plugin>/<server>` — the session that owns this tool. */
  server: string;
  description?: string;
  /** The tool's JSON Schema input shape, verbatim from the server. */
  inputSchema?: unknown;
}

/** @public A live connection to one MCP server. */
export interface McpSession {
  /** `<plugin>/<server>`. */
  key: string;
  /** The connection `mcp()` opened; a plugin server has no profile unless it declares one. */
  connection: McpConnection;
  /** The provider behind it, for a host that registers plugin servers as harness connections. */
  provider: McpProvider;
  tools: McpToolInfo[];
  close(): Promise<void>;
}

/** @public Result of attempting to connect one server. */
export type McpConnectResult =
  | {
      ok: true;
      session: McpSession;
    }
  | {
      ok: false;
      detail: string;
    };

//#endregion

//#region Subprocess environment

/**
 * Build the environment for a stdio MCP server per §9.1.
 *
 * The ordering is normative and load-bearing: a client-selected base
 * environment, then the plugin's configured `env` overlaid on top, and only
 * *then* `PLUGIN_ROOT` and `PLUGIN_DATA`. Setting the reserved variables last
 * is what makes them un-spoofable — validation already rejects an entry that
 * declares them, and this ordering means even a bypass could not win.
 *
 * The base environment is deliberately narrow. §9.1 lets the client "inherit,
 * omit, or sanitize" ambient variables and forbids a conforming plugin from
 * depending on any variable the spec does not require, so passing the agent's
 * whole environment — API keys included — to every plugin subprocess would
 * hand out secrets for no conformance benefit. `PATH` is carried through
 * because §7.2.1 leaves bare-command resolution to the platform search.
 *
 * @public
 */
export function buildSubprocessEnv(params: {
  server: ResolvedStdioServer;
  pluginRoot: string;
  pluginData: string;
  /** Ambient environment to draw the inherited allowlist from. Defaults to `process.env`. */
  baseEnv?: Record<string, string | undefined>;
}): Record<string, string> {
  const ambient = params.baseEnv ?? process.env;
  const base: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const value = ambient[name];
    if (value !== undefined) {
      base[name] = value;
    }
  }

  return {
    ...base,
    ...params.server.env,
    // §9.1: set last, replacing any same-named entry.
    PLUGIN_ROOT: params.pluginRoot,
    PLUGIN_DATA: params.pluginData,
  };
}

/**
 * Ambient variables carried into plugin subprocesses. `PATH` supports the
 * platform executable search for a bare `command`; the rest are the
 * platform-shape variables a process needs to run at all on Windows and
 * POSIX. Nothing here can carry a credential.
 */
const INHERITED_ENV = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'SystemDrive',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'TZ',
];

//#endregion

//#region Connection

/**
 * How long one server gets to start, connect, handshake, and list its tools.
 *
 * Without a bound, a server that opens its pipe and then never answers
 * `initialize` hangs `connect()` forever. That is not hypothetical: it takes
 * the layer's `init` with it, and because the runtime's own init timeout
 * *throws*, one unresponsive plugin aborts the entire agent execution and
 * orphans every subprocess started alongside it. §7.2.2 rule 5 requires the
 * opposite — the client must carry on when a server fails to start or
 * handshake.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 1e4;

/** @public How long a tool call without a caller's signal may run, long operations included. */
export const DEFAULT_TOOL_CALL_TIMEOUT_MS = 6e5;

/** Identifies this client to servers during the MCP handshake. */
const CLIENT_INFO = {
  name: 'noetic-agent-plugins',
  version: '1.0.0',
};

/**
 * The `mcp()` provider for one resolved plugin server: the §9.1 environment
 * for a stdio server, the already-filtered headers for a remote one (which
 * `@noetic-tools/mcp` never forwards across an origin-changing redirect,
 * §7.2.1).
 *
 * A stdio server's `PLUGIN_DATA` directory must exist before launch; call
 * {@link connectMcpServer}, or create it, before connecting.
 *
 * @public
 */
export function pluginMcpProvider(params: {
  server: ResolvedMcpServer;
  pluginRoot: string;
  pluginData: string;
  baseEnv?: Record<string, string | undefined>;
  /** Per-server budget for start + connect + handshake + tools/list. */
  timeoutMs?: number;
}): McpProvider {
  const { server } = params;
  const options = {
    timeoutMs: params.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    clientInfo: CLIENT_INFO,
  };
  if (server.type === McpTransport.Stdio) {
    return mcp({
      ...options,
      command: server.command,
      args: server.args,
      env: buildSubprocessEnv({
        server,
        pluginRoot: params.pluginRoot,
        pluginData: params.pluginData,
        ...(params.baseEnv === undefined
          ? {}
          : {
              baseEnv: params.baseEnv,
            }),
      }),
      cwd: server.cwd,
    });
  }
  return mcp({
    ...options,
    url: server.url,
    // Already stripped during resolution — `server.headers` is by definition
    // what may be sent.
    headers: server.headers,
    protocol: server.type === McpTransport.Sse ? 'sse' : 'streamable-http',
  });
}

function describeFailure(error: unknown): string {
  if (isNoeticError(error) && error.noeticError.kind === 'connection_unavailable') {
    return error.noeticError.reason;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Connect one resolved server and enumerate its tools.
 *
 * Never throws: §7.2.2 rule 5 requires a connection failure to be isolated to
 * that server, so every failure path returns a diagnostic detail instead.
 *
 * @public
 */
export async function connectMcpServer(params: {
  server: ResolvedMcpServer;
  pluginRoot: string;
  pluginData: string;
  baseEnv?: Record<string, string | undefined>;
  /** Per-server budget for start + connect + handshake + tools/list. */
  timeoutMs?: number;
  /** Where binary tool output is stored; defaults to an in-memory store. */
  artifacts?: ArtifactStore;
}): Promise<McpConnectResult> {
  const { server } = params;

  if (server.type === McpTransport.Stdio) {
    // §9.1: PLUGIN_DATA must exist and be writable before the subprocess
    // launches. Creating it here rather than at discovery keeps the guarantee
    // tied to the launch it applies to.
    try {
      await mkdir(params.pluginData, {
        recursive: true,
      });
    } catch (error) {
      return {
        ok: false,
        detail: `§9.1: PLUGIN_DATA directory could not be created: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const provider = pluginMcpProvider(params);
  let connection: McpConnection | undefined;
  try {
    [connection] = await provider.connect({
      name: server.key,
      signal: new AbortController().signal,
      artifacts: params.artifacts ?? createMemoryArtifactStore(),
    });
  } catch (error) {
    return {
      ok: false,
      detail: `§7.2.2: connection failed: ${describeFailure(error)}`,
    };
  }
  if (connection === undefined) {
    return {
      ok: false,
      detail: '§7.2.2: the server offered no connection',
    };
  }
  const live = connection;
  const tools = Object.values(live.manifest.operations).map((op) => ({
    qualifiedName: `${server.key}/${op.name}`,
    name: op.name,
    server: server.key,
    ...(op.description === undefined
      ? {}
      : {
          description: op.description,
        }),
    inputSchema: op.inputSchema,
  }));

  return {
    ok: true,
    session: {
      key: server.key,
      connection: live,
      provider,
      tools,
      close: () => live.release(),
    },
  };
}

function hasContent(value: unknown): value is {
  content: unknown;
} {
  return typeof value === 'object' && value !== null && 'content' in value;
}

/**
 * Invoke a tool on a connected session. A tool that runs as a long operation
 * is waited for.
 *
 * @public
 * @returns The tool result content, or a description of the failure. A failing
 *   tool call is data the model should see and react to, not an exception that
 *   unwinds the agent's turn.
 */
export async function callMcpTool(params: {
  session: McpSession;
  tool: string;
  args: Record<string, unknown>;
  /**
   * Cancels the call and any long operation it waits on — the calling run's
   * abort signal. Without one the call gives up after
   * {@link DEFAULT_TOOL_CALL_TIMEOUT_MS}, so a task that never ends cannot hang the turn.
   */
  signal?: AbortSignal;
}): Promise<{
  ok: boolean;
  content: unknown;
}> {
  const { connection } = params.session;
  const signal = params.signal ?? AbortSignal.timeout(DEFAULT_TOOL_CALL_TIMEOUT_MS);
  try {
    const first = await connection.call(params.tool, params.args, {
      signal,
      idempotencyKey: `agent-plugins:${crypto.randomUUID()}`,
    });
    const outcome =
      first.status === 'task'
        ? await connection.tasks.result(first.taskId, {
            signal,
          })
        : first;
    if (outcome.status === 'error') {
      return {
        ok: false,
        content: outcome.error.details?.content ?? outcome.error.message,
      };
    }
    return {
      ok: true,
      content: hasContent(outcome.output) ? outcome.output.content : outcome.output,
    };
  } catch (error) {
    return {
      ok: false,
      content: `tool call failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Close every session, tolerating individual failures. Teardown must run to
 * completion — one server refusing to shut down cannot be allowed to leak the
 * rest as orphaned subprocesses.
 *
 * @public
 */
export async function closeSessions(sessions: readonly McpSession[]): Promise<void> {
  await Promise.all(sessions.map((session) => session.close().catch(() => {})));
}

//#endregion
