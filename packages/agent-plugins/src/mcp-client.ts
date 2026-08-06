/**
 * Connecting the MCP servers a plugin declares.
 *
 * Agent Plugins defines the *configuration* format; the Model Context Protocol
 * defines the wire behavior. This module is the seam: it takes the resolved
 * entries produced by `mcp-config.ts`, applies the §9.1 subprocess
 * environment, and hands them to the official MCP SDK.
 *
 * §7.2.2 rule 5 is the rule that shapes the error handling here — a server
 * that fails to start, connect, authenticate, or handshake must not stop the
 * client loading anything else. Every failure below becomes a diagnostic and
 * an absent session, never a thrown error.
 */

import { mkdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createSseTransport } from './mcp/sse';
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
  client: Client;
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

//#region Transport construction

async function createTransport(params: {
  server: ResolvedMcpServer;
  pluginRoot: string;
  pluginData: string;
  baseEnv?: Record<string, string | undefined>;
}): Promise<Transport> {
  const { server } = params;

  if (server.type === McpTransport.Stdio) {
    return new StdioClientTransport({
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

  const url = new URL(server.url);
  const requestInit =
    Object.keys(server.headers).length === 0
      ? undefined
      : {
          headers: server.headers,
        };

  if (server.type === McpTransport.StreamableHttp) {
    return new StreamableHTTPClientTransport(url, {
      ...(requestInit === undefined
        ? {}
        : {
            requestInit,
          }),
    });
  }
  return createSseTransport(url, requestInit);
}

//#endregion

//#region Connection

/** Identifies this client to servers during the MCP handshake. */
const CLIENT_INFO = {
  name: 'noetic-agent-plugins',
  version: '1.0.0',
};

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

  const client = new Client(CLIENT_INFO);

  try {
    await client.connect(await createTransport(params));
  } catch (error) {
    return {
      ok: false,
      detail: `§7.2.2: connection failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let tools: McpToolInfo[];
  try {
    const listed = await client.listTools();
    tools = listed.tools.map((tool) => ({
      qualifiedName: `${server.key}/${tool.name}`,
      name: tool.name,
      server: server.key,
      ...(tool.description === undefined
        ? {}
        : {
            description: tool.description,
          }),
      inputSchema: tool.inputSchema,
    }));
  } catch (error) {
    // The handshake succeeded but the server will not describe itself — it is
    // unusable, so close it rather than leave a session with no tools.
    await client.close().catch(() => {});
    return {
      ok: false,
      detail: `§7.2.2: tools/list failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    ok: true,
    session: {
      key: server.key,
      client,
      tools,
      close: async () => {
        await client.close();
      },
    },
  };
}

/**
 * Invoke a tool on a connected session.
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
}): Promise<{
  ok: boolean;
  content: unknown;
}> {
  try {
    const result = await params.session.client.callTool({
      name: params.tool,
      arguments: params.args,
    });
    return {
      ok: result.isError !== true,
      content: result.content,
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
