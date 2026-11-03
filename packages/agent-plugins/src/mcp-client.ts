/**
 * The MCP servers a plugin declares, as harness connections.
 *
 * Agent Plugins defines the *configuration* format; the Model Context Protocol
 * defines the wire behavior. The MCP client, its transports and capability
 * negotiation live in `@noetic-tools/mcp` (spec 35). This module takes the
 * servers `discoverPlugins()` found, resolves each one, applies the §9.1
 * subprocess environment, and hands back one `mcp()` connection entry per
 * server with `expose: 'call'`. The host attaches them to the harness or to a
 * turn, so a plugin's tools pass the same gates — policy, `beforeToolCall`,
 * approval, secret scrubbing, replay-stable idempotency keys — as any other
 * MCP server, and give the same tools as that server attached through `mcp()`.
 *
 * §7.2.2 rule 5 shapes the error handling: a server that fails to start,
 * connect, authenticate, or handshake must not stop the client loading
 * anything else. A server that cannot be resolved becomes a diagnostic; one
 * that fails to connect becomes an unavailable connection in the harness.
 * Neither throws. The one thrown error is a host mistake rather than a server
 * failure: two servers that map to one connection name.
 */

import { mkdir } from 'node:fs/promises';
import type { McpProvider } from '@noetic-tools/mcp';
import { mcp } from '@noetic-tools/mcp';
import type { ConnectionConfig, McpNamedValue } from '@noetic-tools/types';
import { ConnectionConfigErrorCode, NoeticConfigError } from '@noetic-tools/types';
import type { PluginDiagnostic } from './diagnostics';
import { DiagnosticCode, diagnostic } from './diagnostics';
import type { DiscoveryResult, LoadedPlugin } from './discovery';
import type { ResolvedMcpServer, ResolvedStdioServer } from './mcp-config';
import { DEFAULT_TRANSPORTS, McpTransport, resolveMcpServer } from './mcp-config';
import { resolveRoot } from './paths';

//#region Types

/** @public Options for {@link pluginConnections}. */
export interface PluginConnectionsOptions {
  /**
   * MCP transports this host will connect. An entry declaring a transport
   * outside this list is skipped per §7.2.2 rule 4. Defaults to
   * {@link DEFAULT_TRANSPORTS} (`stdio` + `streamable-http`); add `'sse'` to
   * opt into the deprecated HTTP+SSE transport.
   */
  transports?: readonly McpTransport[];
  /** Ambient environment for the §9.1 inherited allowlist. Defaults to `process.env`. */
  baseEnv?: Record<string, string | undefined>;
  /** Per-server budget for start + connect + handshake + tools/list; `mcp()`'s default when absent. */
  timeoutMs?: number;
}

/** @public What {@link pluginConnections} returns. */
export interface PluginConnections {
  /** One `expose: 'call'` entry per usable server, named by {@link pluginConnectionName}. */
  connections: ConnectionConfig[];
  /** The servers that were skipped, and why (§11.3). */
  diagnostics: PluginDiagnostic[];
}

//#endregion

//#region Public API

/**
 * Turn the MCP servers of discovered plugins into harness connection entries,
 * for `new AgentHarness({ connections })` or `execute(…, { connections })`.
 *
 * Creates each plugin's `PLUGIN_DATA` directory (§9.1) before any value can
 * name it. Never connects anything: the harness connects each entry, and one
 * that fails is marked unavailable without touching the rest.
 *
 * @public
 * @throws NoeticConfigError `CONNECTION_NAME_TAKEN` when two servers map to one connection name.
 * @example
 * ```ts
 * const found = await discoverPlugins(roots, dataDir);
 * const { connections } = await pluginConnections(found);
 * const harness = new AgentHarness({ name: 'agent', params: {}, connections });
 * ```
 */
export async function pluginConnections(
  discovered: DiscoveryResult,
  options: PluginConnectionsOptions = {},
): Promise<PluginConnections> {
  claimNames(discovered.plugins);
  const transports = options.transports ?? DEFAULT_TRANSPORTS;
  const out: PluginConnections = {
    connections: [],
    diagnostics: [],
  };
  for (const plugin of discovered.plugins) {
    if (plugin.mcpServers.length === 0) {
      continue;
    }
    await addPlugin(out, {
      plugin,
      transports,
      options,
    });
  }
  return out;
}

/**
 * @public
 * The connection name of a plugin's server: `<plugin>_<server>`, with every
 * character the connection name rule does not allow replaced by `_`.
 * `undefined` when the result still breaks the rule — a plugin name that
 * starts with a digit.
 */
export function pluginConnectionName(pluginName: string, serverKey: string): string | undefined {
  const name = `${pluginName}_${serverKey}`.replace(/[^A-Za-z0-9_-]/g, '_');
  return NAME_PATTERN.test(name) ? name : undefined;
}

/**
 * The `mcp()` provider for one resolved plugin server: the §9.1 environment
 * for a stdio server, the already-filtered headers for a remote one (which
 * `@noetic-tools/mcp` never forwards across an origin-changing redirect,
 * §7.2.1).
 *
 * A stdio server's `PLUGIN_DATA` directory must exist before it launches;
 * {@link pluginConnections} creates it.
 *
 * @public
 */
export function pluginMcpProvider(params: {
  /** The connection name. */
  name: string;
  server: ResolvedMcpServer;
  pluginRoot: string;
  pluginData: string;
  baseEnv?: Record<string, string | undefined>;
  /** Per-server budget for start + connect + handshake + tools/list. */
  timeoutMs?: number;
}): McpProvider {
  const { server } = params;
  const options = {
    name: params.name,
    clientInfo: CLIENT_INFO,
    ...(params.timeoutMs === undefined
      ? {}
      : {
          timeoutMs: params.timeoutMs,
        }),
  };
  if (server.type === McpTransport.Stdio) {
    return mcp({
      ...options,
      command: server.command,
      args: server.args,
      env: namedValues(
        buildSubprocessEnv({
          server,
          pluginRoot: params.pluginRoot,
          pluginData: params.pluginData,
          ...(params.baseEnv === undefined
            ? {}
            : {
                baseEnv: params.baseEnv,
              }),
        }),
      ),
      cwd: server.cwd,
    });
  }
  return mcp({
    ...options,
    type: server.type === McpTransport.Sse ? 'sse' : 'http',
    url: server.url,
    // Already stripped during resolution — `server.headers` is by definition
    // what may be sent.
    headers: namedValues(server.headers),
  });
}

/** A record of headers or environment variables as the `[{ name, value }]` list `mcp()` takes. */
function namedValues(record: Readonly<Record<string, string>>): McpNamedValue[] {
  return Object.entries(record).map(([name, value]) => ({
    name,
    value,
  }));
}

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

//#region Servers

/** Identifies this client to servers during the MCP handshake. */
const CLIENT_INFO = {
  name: 'noetic-agent-plugins',
  version: '1.0.0',
};

/** The harness connection name rule (`CONNECTION_NAME_PATTERN` in core). */
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Refuses two servers that map to one connection name. The mapping folds `.`
 * and `/` into `_`, so `a.b`'s `c` and `a`'s `b_c` would otherwise both be
 * `a_b_c`, and one would silently stand in for the other.
 */
function claimNames(plugins: readonly LoadedPlugin[]): void {
  const claimed = new Map<string, string>();
  for (const plugin of plugins) {
    for (const server of plugin.mcpServers) {
      const name = pluginConnectionName(plugin.manifest.name, server.key);
      if (name === undefined) {
        continue;
      }
      const holder = claimed.get(name);
      if (holder !== undefined) {
        throw new NoeticConfigError({
          code: ConnectionConfigErrorCode.NameTaken,
          message: `Plugin servers '${holder}' and '${server.qualifiedKey}' both map to connection '${name}'.`,
          hint: 'Rename one of the servers in its mcp.json, or leave one of the plugins out.',
        });
      }
      claimed.set(name, server.qualifiedKey);
    }
  }
}

async function addPlugin(
  out: PluginConnections,
  params: {
    plugin: LoadedPlugin;
    transports: readonly McpTransport[];
    options: PluginConnectionsOptions;
  },
): Promise<void> {
  const { plugin, transports, options } = params;
  const report = (component: string, code: DiagnosticCode, detail: string): void => {
    out.diagnostics.push(
      diagnostic({
        code,
        pluginDir: plugin.root,
        pluginName: plugin.manifest.name,
        component,
        detail,
      }),
    );
  };
  const data = await ensureDataDir(plugin.dataDir);
  // §9.1 defines PLUGIN_DATA as an absolute, filesystem-resolved path, so it is
  // resolved before it can be substituted into any `args`, `env` or `cwd`.
  const vars = {
    pluginRoot: plugin.root,
    pluginData: data.path,
  };

  for (const declared of plugin.mcpServers) {
    if (!transports.includes(declared.config.type)) {
      report(
        declared.key,
        DiagnosticCode.McpTransportUnsupported,
        `§7.2.2: transport '${declared.config.type}' is not enabled on this host`,
      );
      continue;
    }
    const name = pluginConnectionName(plugin.manifest.name, declared.key);
    if (name === undefined) {
      report(
        declared.key,
        DiagnosticCode.McpServerInvalid,
        `'${plugin.manifest.name}_${declared.key}' cannot be a connection name: it must start with a letter`,
      );
      continue;
    }
    if (declared.config.type === McpTransport.Stdio && data.failure !== undefined) {
      report(declared.key, DiagnosticCode.McpConnectFailed, data.failure);
      continue;
    }
    const resolved = await resolveMcpServer({
      key: declared.qualifiedKey,
      config: declared.config,
      vars,
    });
    if (!resolved.ok) {
      report(declared.key, DiagnosticCode.McpServerInvalid, resolved.detail);
      continue;
    }
    // §7.2.1: client-generated headers win. Resolution already removed them,
    // so this only reports — a plugin author who set `Authorization` and saw
    // it quietly ignored would otherwise have no way to find out.
    for (const dropped of resolved.droppedHeaders) {
      report(declared.key, DiagnosticCode.McpHeaderDropped, dropped.reason);
    }
    out.connections.push({
      provider: pluginMcpProvider({
        name,
        server: resolved.server,
        pluginRoot: plugin.root,
        pluginData: vars.pluginData,
        ...(options.baseEnv === undefined
          ? {}
          : {
              baseEnv: options.baseEnv,
            }),
        ...(options.timeoutMs === undefined
          ? {}
          : {
              timeoutMs: options.timeoutMs,
            }),
      }),
      expose: 'call',
    });
  }
}

/**
 * Creates a plugin's `PLUGIN_DATA` directory and returns its resolved path.
 * When it cannot be created, `failure` says why, and only the plugin's stdio
 * servers — the ones that would run in it — are skipped.
 */
async function ensureDataDir(dataDir: string): Promise<{
  path: string;
  failure?: string;
}> {
  try {
    await mkdir(dataDir, {
      recursive: true,
    });
  } catch (error) {
    return {
      path: dataDir,
      failure: `§9.1: PLUGIN_DATA directory could not be created: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    path: (await resolveRoot(dataDir)) ?? dataDir,
  };
}

//#endregion
