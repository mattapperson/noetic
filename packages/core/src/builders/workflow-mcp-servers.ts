/**
 * The MCP servers a document's `acp-agent` nodes hand to an agent. A stdio
 * server is a command the agent launches, and a header or environment value
 * reaches the agent process, so a document a host did not write may name only
 * the servers the host's `mcp` allowlist grants (spec 26 § MCP servers).
 */

import type {
  AcpMcpServer,
  Context,
  Lazy,
  McpAllowlist,
  McpCommandGrant,
  McpUrlGrant,
  SecretResolver,
  WorkflowDocument,
  WorkflowMcpServer,
  WorkflowNode,
} from '@noetic-tools/types';
import { NoeticConfigError, walkWorkflow } from '@noetic-tools/types';
import { harnessInternal } from '../util/harness-internals';
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

/** A header or environment entry as a document writes it. */
type NamedValue = UrlServer['headers'][number];

//#endregion

//#region Public API

/**
 * Checks every MCP server a document's `acp-agent` nodes name against the
 * host's allowlist. No allowlist grants nothing. Inline subflows count; named
 * refs resolve from the host's own registry and are not checked.
 *
 * @throws `NoeticConfigError` `CONNECTION_NOT_ALLOWED` for a server, header or environment value the allowlist does not grant.
 * @throws `NoeticConfigError` `CONNECTION_INVALID` for a value that is a `$secret` when the harness has no `secrets` resolver, or an allowlist URL pattern that does not parse.
 */
export function checkMcpServers(
  doc: WorkflowDocument,
  allowlist: McpAllowlist | undefined,
  secrets: SecretResolver | undefined,
): void {
  for (const node of walkWorkflow(doc.root)) {
    for (const server of serversOf(node)) {
      checkServer(node.id, server, allowlist ?? {});
      if (!secrets && !isLiteral(server)) {
        throw noResolver();
      }
    }
  }
}

/**
 * The servers an `acp-agent` step gets: as written, or — when a value is a
 * `$secret` — resolved through the harness's `environment.secrets` when the
 * session starts.
 */
export function stepMcpServers(
  servers: ReadonlyArray<WorkflowMcpServer> | undefined,
): Lazy<ReadonlyArray<AcpMcpServer> | undefined> {
  if (!servers || servers.every(isLiteral)) {
    return servers;
  }
  return (ctx) => resolveServers(servers, ctx);
}

/** The planner's view of the servers it may give an `acp-agent` node. */
export function mcpPrompt(allowlist: McpAllowlist | undefined): string {
  const lines = [
    ...(allowlist?.urls ?? []).map(urlLine),
    ...(allowlist?.commands ?? []).map(commandLine),
  ];
  if (lines.length === 0) {
    return '\nNo MCP servers are available: do not give acp-agent nodes "mcpServers".';
  }
  return `\nMCP servers an acp-agent node may list in "mcpServers" (no others; header and env values only as the { "$secret": "<name>" } shown; write each URL as \`new URL(url).href\` gives it back, e.g. "https://host/" with a lowercase host and a path):
${lines.join('\n')}`;
}

//#endregion

//#region Checks

function serversOf(node: WorkflowNode): ReadonlyArray<WorkflowMcpServer> {
  return node.kind === 'acp-agent' ? (node.mcpServers ?? []) : [];
}

function checkServer(nodeId: string, server: WorkflowMcpServer, allowlist: McpAllowlist): void {
  if ('url' in server) {
    checkUrlServer(nodeId, server, allowlist.urls ?? []);
    return;
  }
  checkStdioServer(nodeId, server, allowlist.commands ?? []);
}

function checkUrlServer(
  nodeId: string,
  server: UrlServer,
  grants: ReadonlyArray<McpUrlGrant>,
): void {
  const url = plainUrl(nodeId, server);
  const matching = grants.filter((g) => urlPatternMatches(g.url, url));
  if (matching.length === 0) {
    throw notAllowed(
      `Node '${nodeId}' gives the agent MCP server '${server.name}' at ${server.url}, which the host does not allow.`,
      `Allowed MCP server URLs: ${grants.map((g) => g.url).join(', ') || '(none)'}.`,
    );
  }
  checkValues(server.headers, matching, {
    nodeId,
    server: server.name,
    what: 'header',
  });
}

function checkStdioServer(
  nodeId: string,
  server: StdioServer,
  grants: ReadonlyArray<McpCommandGrant>,
): void {
  const matching = grants.filter(
    (g) => g.command === server.command && sameArgs(g.args ?? [], server.args),
  );
  if (matching.length === 0) {
    throw notAllowed(
      `Node '${nodeId}' gives the agent stdio MCP server '${server.name}' (${commandText(server.command, server.args)}), which the host does not allow.`,
      `Allowed MCP server commands: ${grants.map((g) => commandText(g.command, g.args ?? [])).join('; ') || '(none)'}.`,
    );
  }
  checkValues(server.env, matching, {
    nodeId,
    server: server.name,
    what: 'environment variable',
  });
}

/**
 * Every header or environment value must be a `$secret` that one grant matching
 * the server binds to that name — the same grant for all of them, so a looser
 * grant listed first cannot hide a tighter one that allows the values.
 */
function checkValues(
  values: ReadonlyArray<NamedValue>,
  grants: ReadonlyArray<McpUrlGrant | McpCommandGrant>,
  where: ValueSite,
): void {
  if (grants.some((g) => values.every((entry) => binds(g, entry, where.what)))) {
    return;
  }
  const { nodeId, server, what } = where;
  const entry = values.find((e) => !grants.some((g) => binds(g, e, what)));
  if (!entry) {
    throw notAllowed(
      `Node '${nodeId}' sets ${what}s ${values.map((e) => `'${e.name}'`).join(', ')} on MCP server '${server}', which no one grant allows together.`,
      `Name only the ${what}s one grant binds.`,
    );
  }
  const granted = grants.flatMap((g) =>
    Object.entries(g.secrets ?? {})
      .filter(([, name]) => sameName(name, entry.name, what))
      .map(([secret]) => `{ "$secret": "${secret}" }`),
  );
  throw notAllowed(
    `Node '${nodeId}' sets ${what} '${entry.name}' on MCP server '${server}' to a value the host does not allow.`,
    granted.length > 0
      ? `'${entry.name}' takes only ${granted.join(' or ')}.`
      : `The host binds no secret to ${what} '${entry.name}'.`,
  );
}

interface ValueSite {
  readonly nodeId: string;
  readonly server: string;
  readonly what: 'header' | 'environment variable';
}

function binds(
  grant: McpUrlGrant | McpCommandGrant,
  entry: NamedValue,
  what: ValueSite['what'],
): boolean {
  if (
    !isSecret(entry.value) ||
    !grant.secrets ||
    !Object.hasOwn(grant.secrets, entry.value.$secret)
  ) {
    return false;
  }
  return sameName(grant.secrets[entry.value.$secret] ?? '', entry.name, what);
}

/** HTTP header names are case-insensitive; environment variable names are not. */
function sameName(granted: string, written: string, what: ValueSite['what']): boolean {
  return what === 'header' ? granted.toLowerCase() === written.toLowerCase() : granted === written;
}

/**
 * The server's URL, when it is http(s), carries no user or password
 * (`http://localhost:1@evil.example/` would otherwise match
 * `http://localhost:*`), and is written exactly as `URL` reads it back. The
 * agent gets the URL as written, so a URL whose reading differs — a backslash,
 * a tab, an uppercase host — is refused rather than checked in one form and
 * used in another.
 */
function plainUrl(nodeId: string, server: UrlServer): URL {
  const parsed = URL.canParse(server.url) ? new URL(server.url) : undefined;
  if (
    !parsed ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    throw notAllowed(
      `Node '${nodeId}' gives the agent MCP server '${server.name}' at ${JSON.stringify(server.url)}, which is not an http: or https: URL without a user or password.`,
      'Give an http: or https: URL with no user or password.',
    );
  }
  if (parsed.href !== server.url) {
    throw notAllowed(
      `Node '${nodeId}' gives the agent MCP server '${server.name}' at ${JSON.stringify(server.url)}, which reads as ${parsed.href}.`,
      `Write the URL as ${parsed.href}.`,
    );
  }
  return parsed;
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

function noResolver(): NoeticConfigError {
  return new NoeticConfigError({
    code: 'CONNECTION_INVALID',
    message: 'An MCP server uses a $secret but the harness has no secret resolver.',
    hint: 'Set `environment.secrets` on the AgentHarness to resolve secret names.',
  });
}

//#endregion

//#region Secrets

async function resolveServers(
  servers: ReadonlyArray<WorkflowMcpServer>,
  ctx: Context,
): Promise<ReadonlyArray<AcpMcpServer>> {
  const resolver = harnessInternal<SecretResolver>(ctx.harness, 'secrets');
  if (!resolver) {
    throw noResolver();
  }
  const signal = ctx.aborted ? AbortSignal.abort(ctx.abortReason) : new AbortController().signal;
  const resolve = async (entry: NamedValue) => ({
    name: entry.name,
    value: isSecret(entry.value)
      ? await resolver.resolve(entry.value.$secret, {
          signal,
        })
      : entry.value,
  });
  return Promise.all(
    servers.map(async (server) =>
      withValues(server, await Promise.all(valuesOf(server).map(resolve))),
    ),
  );
}

function valuesOf(server: WorkflowMcpServer): ReadonlyArray<NamedValue> {
  return 'url' in server ? server.headers : server.env;
}

function withValues(
  server: WorkflowMcpServer,
  values: Array<{
    name: string;
    value: string;
  }>,
): AcpMcpServer {
  return 'url' in server
    ? {
        ...server,
        headers: values,
      }
    : {
        ...server,
        env: values,
      };
}

/** Whether no header or environment value is a `$secret`, so the server is already an ACP one. */
function isLiteral(server: WorkflowMcpServer): server is AcpMcpServer {
  return valuesOf(server).every((entry) => !isSecret(entry.value));
}

function isSecret(value: NamedValue['value']): value is {
  $secret: string;
} {
  return typeof value !== 'string';
}

//#endregion

//#region Prompt

function urlLine(grant: McpUrlGrant): string {
  const headers = Object.entries(grant.secrets ?? {}).map(
    ([secret, header]) => `{ "name": "${header}", "value": { "$secret": "${secret}" } }`,
  );
  return `- { "type": "http" or "sse", "name": "<name>", "url": "<URL matching ${grant.url}>", "headers": [${headers.join(', ')}] } (headers optional)`;
}

function commandLine(grant: McpCommandGrant): string {
  const env = Object.entries(grant.secrets ?? {}).map(
    ([secret, variable]) => `{ "name": "${variable}", "value": { "$secret": "${secret}" } }`,
  );
  return `- { "name": "<name>", "command": ${JSON.stringify(grant.command)}, "args": ${JSON.stringify(grant.args ?? [])}, "env": [${env.join(', ')}] } (env optional)`;
}

//#endregion
