/**
 * The MCP servers a document names: `{ "mcp": … }` entries in a node's
 * `tools` or the document's `connections`. Each becomes a connection entry,
 * with noetic as the MCP client, built by the host's `mcp.provider` from the
 * one grant that allows it — so a document a host did not write reaches only
 * the URLs and exact commands the host grants, with only the secrets the
 * grant binds and the policy the grant sets (spec 26 § MCP servers).
 *
 * One server through one `provider` and `spawn` is always one provider
 * object, so two nodes that name it share one connection.
 */

import type {
  ConnectionConfig,
  ConnectionProvider,
  ConnectOptions,
  GrantedMcpServer,
  McpAllowlist,
  McpCommandGrant,
  McpNamedValue,
  McpUrlGrant,
  SecretResolver,
  Spawn,
  WorkflowDocument,
  WorkflowMcpSecretValue,
  WorkflowMcpServer,
  WorkflowNode,
} from '@noetic-tools/types';
import { NoeticConfigError, walkWorkflow } from '@noetic-tools/types';
import { urlPatternMatches } from './mcp-url-pattern';

//#region Types

type UrlServer = Extract<
  WorkflowMcpServer,
  {
    url: string;
  }
>;

type StdioServer = Extract<
  WorkflowMcpServer,
  {
    command: string;
  }
>;

type Grant = McpUrlGrant | McpCommandGrant;

//#endregion

//#region Public API

/**
 * Checks every MCP server a document names — in its `connections`, or a
 * `callModel` or `acp-agent` node's `tools` — against the host's allowlist.
 * No allowlist grants nothing. Inline subflows count; named refs resolve from
 * the host's own registry and are not checked.
 *
 * @throws `NoeticConfigError` `CONNECTION_NOT_ALLOWED` for a server, header or environment value the allowlist does not grant, or a header or environment variable named twice.
 * @throws `NoeticConfigError` `CONNECTION_INVALID` for a `$secret` value when the harness has no `secrets` resolver, or an allowlist URL pattern that does not parse.
 */
export function checkMcpServers(
  doc: WorkflowDocument,
  allowlist: McpAllowlist | undefined,
  secrets: SecretResolver | undefined,
): void {
  const check = (where: string, server: WorkflowMcpServer) => {
    grantOf(where, server, allowlist ?? {});
    if (!secrets && valuesOf(server).length > 0) {
      throw noResolver(server.name);
    }
  };
  for (const server of documentServers(doc)) {
    check(DOCUMENT_WHERE, server);
  }
  for (const node of walkWorkflow(doc.root)) {
    for (const server of serversOf(node)) {
      check(`Node '${node.id}'`, server);
    }
  }
}

/** The servers a document's `connections` bring, as `{ "mcp": … }` entries. */
export function documentServers(doc: WorkflowDocument): WorkflowMcpServer[] {
  return Object.values(doc.connections ?? {}).flatMap((entry) =>
    entry.mcp
      ? [
          entry.mcp,
        ]
      : [],
  );
}

/** Names the document's `connections` in errors, where a node's id would go. */
export const DOCUMENT_WHERE = "The document's connections";

/**
 * The connection entry for a server a node or the document names: the host's
 * provider for it, with the policy of the grant that allows it. A stdio
 * server an `acp-agent` node names starts through its agent's `spawn`, where
 * the agent runs. The same server is always the same provider, so two nodes
 * that name it share one connection, and a different server under a taken
 * name is `CONNECTION_NAME_TAKEN` when the turn attaches it.
 *
 * @throws `NoeticConfigError` `CONNECTION_NOT_ALLOWED` when no grant allows it; `CONNECTION_INVALID` when the allowlist has no `provider`.
 */
export function mcpEntry(
  where: string,
  server: WorkflowMcpServer,
  host: {
    readonly allowlist: McpAllowlist | undefined;
    /** Where a stdio server starts: its `acp-agent` node's agent. */
    readonly spawn?: Spawn;
  },
): ConnectionConfig {
  const { allowlist, spawn } = host;
  const grant = grantOf(where, server, allowlist ?? {});
  const open = allowlist?.provider;
  if (!open) {
    throw new NoeticConfigError({
      code: 'CONNECTION_INVALID',
      message: `${where} names MCP server '${server.name}', but the host gives no way to connect it.`,
      hint: 'Set `mcp.provider` on the allowlist: `provider: mcp`, from @noetic-tools/mcp.',
    });
  }
  return {
    provider: serverProvider(server, open, spawn),
    ...(grant.policy
      ? {
          policy: grant.policy,
        }
      : {}),
  };
}

/** The planner's view of the MCP servers it may attach: each URL pattern, with the headers its secrets fill. */
export function mcpPrompt(allowlist: McpAllowlist | undefined): string {
  const lines = [
    ...(allowlist?.urls ?? []).map(urlLine),
    ...(allowlist?.commands ?? []).map(commandLine),
  ];
  if (lines.length === 0) {
    return '\nNo MCP servers are available: do not give a node an { "mcp": … } tool entry.';
  }
  return `\nMCP servers a callModel or acp-agent node may attach as a "tools" entry, or the document as a "connections" entry (no others; header and env values only as the { "$secret": "<name>" } shown; write each URL as \`new URL(url).href\` gives it back, e.g. "https://host/" with a lowercase host and a path):
${lines.join('\n')}`;
}

//#endregion

//#region Checks

function serversOf(node: WorkflowNode): ReadonlyArray<WorkflowMcpServer> {
  if (node.kind !== 'callModel' && node.kind !== 'acp-agent') {
    return [];
  }
  return (node.tools ?? []).flatMap((entry) =>
    'mcp' in entry
      ? [
          entry.mcp,
        ]
      : [],
  );
}

/**
 * The grant that allows a server: the first that matches it and binds every
 * one of its header or environment values, so a looser grant listed first
 * cannot hide a tighter one that allows the values.
 *
 * @throws `NoeticConfigError` `CONNECTION_NOT_ALLOWED` when none does, or a value is named twice.
 */
function grantOf(where: string, server: WorkflowMcpServer, allowlist: McpAllowlist): Grant {
  if ('url' in server) {
    return urlGrant(where, server, allowlist.urls ?? []);
  }
  return commandGrant(where, server, allowlist.commands ?? []);
}

function urlGrant(where: string, server: UrlServer, grants: ReadonlyArray<McpUrlGrant>): Grant {
  const url = plainUrl(where, server);
  const matching = grants.filter((g) => urlPatternMatches(g.url, url));
  if (matching.length === 0) {
    throw notAllowed(
      `${where} names MCP server '${server.name}' at ${server.url}, which the host does not allow.`,
      `Allowed MCP server URLs: ${grants.map((g) => g.url).join(', ') || '(none)'}.`,
    );
  }
  return bindingGrant(server.headers ?? [], matching, {
    where,
    server: server.name,
    what: 'header',
  });
}

function commandGrant(
  where: string,
  server: StdioServer,
  grants: ReadonlyArray<McpCommandGrant>,
): Grant {
  const matching = grants.filter(
    (g) => g.command === server.command && sameArgs(g.args ?? [], server.args ?? []),
  );
  if (matching.length === 0) {
    throw notAllowed(
      `${where} names stdio MCP server '${server.name}' (${commandText(server.command, server.args ?? [])}), which the host does not allow.`,
      `Allowed MCP server commands: ${grants.map((g) => commandText(g.command, g.args ?? [])).join('; ') || '(none)'}.`,
    );
  }
  return bindingGrant(server.env ?? [], matching, {
    where,
    server: server.name,
    what: 'environment variable',
  });
}

interface ValueSite {
  readonly where: string;
  readonly server: string;
  readonly what: 'header' | 'environment variable';
}

/**
 * The first matching grant that binds every header or environment value —
 * each a `$secret` the grant binds to that name. Each name appears once:
 * which of two `Authorization` headers a server receives is up to the client.
 */
function bindingGrant(
  values: ReadonlyArray<WorkflowMcpSecretValue>,
  grants: ReadonlyArray<Grant>,
  site: ValueSite,
): Grant {
  const { where, server, what } = site;
  const twice = values.find((entry, i) =>
    values.slice(0, i).some((earlier) => sameName(earlier.name, entry.name, what)),
  );
  if (twice) {
    throw notAllowed(
      `${where} sets ${what} '${twice.name}' on MCP server '${server}' more than once.`,
      `Name each ${what} once.`,
    );
  }
  const grant = grants.find((g) => values.every((entry) => binds(g, entry, what)));
  if (grant) {
    return grant;
  }
  const entry = values.find((e) => !grants.some((g) => binds(g, e, what)));
  if (!entry) {
    throw notAllowed(
      `${where} sets ${what}s ${values.map((e) => `'${e.name}'`).join(', ')} on MCP server '${server}', which no one grant allows together.`,
      `Name only the ${what}s one grant binds.`,
    );
  }
  const granted = grants.flatMap((g) =>
    Object.entries(g.secrets ?? {})
      .filter(([, name]) => sameName(name, entry.name, what))
      .map(([secret]) => `{ "$secret": "${secret}" }`),
  );
  throw notAllowed(
    `${where} sets ${what} '${entry.name}' on MCP server '${server}' to a value the host does not allow.`,
    granted.length > 0
      ? `'${entry.name}' takes only ${granted.join(' or ')}.`
      : `The host binds no secret to ${what} '${entry.name}'.`,
  );
}

function binds(grant: Grant, entry: WorkflowMcpSecretValue, what: ValueSite['what']): boolean {
  const secrets = grant.secrets;
  if (!secrets || !Object.hasOwn(secrets, entry.value.$secret)) {
    return false;
  }
  return sameName(secrets[entry.value.$secret] ?? '', entry.name, what);
}

/** HTTP header names are case-insensitive; environment variable names are not. */
function sameName(granted: string, written: string, what: ValueSite['what']): boolean {
  return what === 'header' ? granted.toLowerCase() === written.toLowerCase() : granted === written;
}

/**
 * The server's URL, when it is http(s), carries no user or password
 * (`http://localhost:1@evil.example/` would otherwise match
 * `http://localhost:*`), and is written exactly as `URL` reads it back. The
 * server is connected at the URL as written, so a URL whose reading differs —
 * a backslash, a tab, an uppercase host — is refused rather than checked in
 * one form and used in another.
 *
 * @throws `NoeticConfigError` `CONNECTION_NOT_ALLOWED` otherwise.
 */
function plainUrl(where: string, server: UrlServer): URL {
  const parsed = URL.canParse(server.url) ? new URL(server.url) : undefined;
  if (
    !parsed ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw notAllowed(
      `${where} names MCP server '${server.name}' at ${JSON.stringify(server.url)}, which is not an http: or https: URL without a user or password.`,
      'Give an http: or https: URL with no user or password.',
    );
  }
  if (parsed.href !== server.url) {
    throw notAllowed(
      `${where} names MCP server '${server.name}' at ${JSON.stringify(server.url)}, which reads as ${parsed.href}.`,
      `Write the URL as ${parsed.href}.`,
    );
  }
  return parsed;
}

function valuesOf(server: WorkflowMcpServer): ReadonlyArray<WorkflowMcpSecretValue> {
  return ('url' in server ? server.headers : server.env) ?? [];
}

function sameArgs(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((arg, i) => arg === b[i]);
}

function commandText(command: string, args: ReadonlyArray<string>): string {
  return JSON.stringify([
    command,
    ...args,
  ]);
}

function notAllowed(message: string, hint: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'CONNECTION_NOT_ALLOWED',
    message,
    hint,
  });
}

function noResolver(server: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'CONNECTION_INVALID',
    message: `MCP server '${server}' uses a $secret, but the harness has no secret resolver.`,
    hint: 'Set `environment.secrets` on the AgentHarness to resolve secret names.',
  });
}

//#endregion

//#region Prompt

function urlLine(grant: McpUrlGrant): string {
  const headers = Object.entries(grant.secrets ?? {}).map(
    ([secret, header]) => `{ "name": "${header}", "value": { "$secret": "${secret}" } }`,
  );
  return `- { "mcp": { "name": "<name>", "type": "http" or "sse", "url": "<URL matching ${grant.url}>", "headers": [${headers.join(', ')}] } } (headers optional)`;
}

function commandLine(grant: McpCommandGrant): string {
  const env = Object.entries(grant.secrets ?? {}).map(
    ([secret, variable]) => `{ "name": "${variable}", "value": { "$secret": "${secret}" } }`,
  );
  return `- { "mcp": { "name": "<name>", "command": ${JSON.stringify(grant.command)}, "args": ${JSON.stringify(grant.args ?? [])}, "env": [${env.join(', ')}] } } (env optional)`;
}

//#endregion

//#region Providers

/** Providers already built, by `provider`, then by `spawn`, then by server. */
const PROVIDERS = new WeakMap<
  NonNullable<McpAllowlist['provider']>,
  WeakMap<object, Map<string, ConnectionProvider>>
>();

/** Stands in for "no spawn" as a WeakMap key. */
const NO_SPAWN: object = {};

/**
 * The provider for a granted server. It resolves the server's secrets when it
 * connects, so a value never sits in the step graph.
 */
function serverProvider(
  server: WorkflowMcpServer,
  open: NonNullable<McpAllowlist['provider']>,
  spawn: Spawn | undefined,
): ConnectionProvider {
  const bySpawn = PROVIDERS.get(open) ?? new WeakMap<object, Map<string, ConnectionProvider>>();
  PROVIDERS.set(open, bySpawn);
  const built = bySpawn.get(spawn ?? NO_SPAWN) ?? new Map<string, ConnectionProvider>();
  bySpawn.set(spawn ?? NO_SPAWN, built);
  const key = JSON.stringify(server);
  const held = built.get(key);
  if (held) {
    return held;
  }
  const provider: ConnectionProvider = {
    name: server.name,
    connect: async (opts) => open(await granted(server, spawn, opts)).connect(opts),
  };
  built.set(key, provider);
  return provider;
}

/** The server in ACP's shape with each secret resolved through the harness and registered for scrubbing. */
async function granted(
  server: WorkflowMcpServer,
  spawn: Spawn | undefined,
  opts: ConnectOptions,
): Promise<GrantedMcpServer> {
  if ('url' in server) {
    return {
      name: server.name,
      type: server.type,
      url: server.url,
      headers: await resolveValues(server.headers ?? [], opts),
    };
  }
  return {
    name: server.name,
    command: server.command,
    args: server.args ?? [],
    env: await resolveValues(server.env ?? [], opts),
    ...(spawn
      ? {
          spawn,
        }
      : {}),
  };
}

/**
 * @throws `NoeticConfigError` `CONNECTION_INVALID` when the harness has no secret resolver.
 */
async function resolveValues(
  values: ReadonlyArray<WorkflowMcpSecretValue>,
  opts: ConnectOptions,
): Promise<McpNamedValue[]> {
  const secrets = opts.secrets;
  if (values.length === 0) {
    return [];
  }
  if (!secrets) {
    throw noResolver(opts.name);
  }
  const resolved: McpNamedValue[] = [];
  for (const entry of values) {
    const value = await secrets.resolve(entry.value.$secret, {
      signal: opts.signal,
    });
    opts.redact?.(value);
    resolved.push({
      name: entry.name,
      value,
    });
  }
  return resolved;
}

//#endregion
