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
import type { FetchLike, Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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

/** Redirect hops to follow before giving up, matching the fetch default. */
const MAX_REDIRECTS = 20;

/**
 * A `fetch` that drops plugin-configured headers when a redirect crosses an
 * origin.
 *
 * §7.2.1: "A client MUST NOT forward configured headers to a different origin
 * through a redirect … without explicit user authorization." Plain `fetch`
 * follows redirects itself and re-sends custom headers to the new origin —
 * verified on the wire, an `X-Tenant` carrying a tenant token reached a
 * different-origin target through a 307. (`Authorization` is stripped by fetch
 * itself; custom headers, which are exactly the ones §7.2.1 contemplates, are
 * not.)
 *
 * So redirects are followed manually: same origin keeps the configured
 * headers, a different origin re-issues without them.
 */
function originAwareFetch(configured: Record<string, string>): FetchLike {
  const configuredNames = Object.keys(configured).map((name) => name.toLowerCase());

  return async (input: string | URL, init?: RequestInit): Promise<Response> => {
    let url = new URL(input);
    const origin = url.origin;
    let headers = new Headers(init?.headers);
    // The per-hop init. A 303 — or a 301/302 on a POST — rewrites it to a
    // bodyless GET, so it has to be a local rather than the parameter.
    const request: RequestInit = {
      ...init,
    };
    let response: Response;

    for (let hop = 0; ; hop++) {
      response = await fetch(url, {
        ...request,
        headers,
        // Manual, so the decision about what to re-send is ours.
        redirect: 'manual',
      });

      const location = response.headers.get('location');
      if (location === null || response.status < 300 || response.status >= 400) {
        return response;
      }
      if (hop >= MAX_REDIRECTS) {
        return response;
      }

      url = new URL(location, url);
      if (url.origin !== origin) {
        // Crossed an origin: strip everything the plugin configured before
        // following. Anything the SDK added (content-type, session id) stays.
        const stripped = new Headers(headers);
        for (const name of configuredNames) {
          stripped.delete(name);
        }
        headers = stripped;
      }
      // A 303, or a 301/302 on a POST, becomes a GET without a body. Mutating
      // `request` is what makes this take effect — the fetch above spreads
      // `request`, so rewriting the `init` parameter would change nothing.
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && request.method === 'POST')
      ) {
        request.method = 'GET';
        request.body = undefined;
      }
    }
  };
}

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
  // Already stripped during resolution — `server.headers` is by definition what
  // may be sent, so there is nothing to filter here.
  const safeHeaders = server.headers;
  const requestInit =
    Object.keys(safeHeaders).length === 0
      ? undefined
      : {
          headers: safeHeaders,
        };

  const guardedFetch = originAwareFetch(safeHeaders);

  if (server.type === McpTransport.StreamableHttp) {
    return new StreamableHTTPClientTransport(url, {
      fetch: guardedFetch,
      ...(requestInit === undefined
        ? {}
        : {
            requestInit,
          }),
    });
  }
  return createSseTransport(url, requestInit, guardedFetch);
}

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

/**
 * Race `work` against a deadline. On expiry the caller must close whatever
 * `work` was waiting on — the losing promise keeps running otherwise, which is
 * precisely how the subprocesses leaked.
 */
async function withDeadline<T>(
  work: Promise<T>,
  ms: number,
): Promise<
  | {
      timedOut: false;
      value: T;
    }
  | {
      timedOut: true;
    }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{
    timedOut: true;
  }>((settle) => {
    timer = setTimeout(
      () =>
        settle({
          timedOut: true,
        }),
      ms,
    );
  });
  try {
    return await Promise.race([
      work.then((value) => ({
        timedOut: false as const,
        value,
      })),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

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
  /** Per-server budget for start + connect + handshake + tools/list. */
  timeoutMs?: number;
}): Promise<McpConnectResult> {
  const { server } = params;
  const timeoutMs = params.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

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

  /** Close the client, swallowing the failure — teardown must not mask the cause. */
  const abandon = async (): Promise<void> => {
    await client.close().catch(() => {});
  };

  try {
    const connected = await withDeadline(
      createTransport(params).then((transport) => client.connect(transport)),
      timeoutMs,
    );
    if (connected.timedOut) {
      // Close it, or the subprocess outlives us with nobody holding a handle.
      await abandon();
      return {
        ok: false,
        detail: `§7.2.2: server did not complete the MCP handshake within ${timeoutMs}ms`,
      };
    }
  } catch (error) {
    await abandon();
    return {
      ok: false,
      detail: `§7.2.2: connection failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let tools: McpToolInfo[];
  try {
    const listed = await withDeadline(client.listTools(), timeoutMs);
    if (listed.timedOut) {
      await abandon();
      return {
        ok: false,
        detail: `§7.2.2: server did not answer tools/list within ${timeoutMs}ms`,
      };
    }
    tools = listed.value.tools.map((tool) => ({
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
    await abandon();
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
