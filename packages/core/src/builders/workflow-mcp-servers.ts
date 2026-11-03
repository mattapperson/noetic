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
import { globMatches } from './workflow-connections';

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
 */
export function checkMcpServers(doc: WorkflowDocument, allowlist: McpAllowlist | undefined): void {
  for (const node of walkWorkflow(doc.root)) {
    for (const server of serversOf(node)) {
      checkServer(node.id, server, allowlist ?? {});
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
  return `\nMCP servers an acp-agent node may list in "mcpServers" (no others; header and env values only as the { "$secret": "<name>" } shown):
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
  const href = plainUrl(server.url);
  const grant = href === undefined ? undefined : grants.find((g) => globMatches(g.url, href));
  if (!grant) {
    throw notAllowed(
      `Node '${nodeId}' gives the agent MCP server '${server.name}' at ${server.url}, which the host does not allow.`,
      `Allowed MCP server URLs: ${grants.map((g) => g.url).join(', ') || '(none)'}.`,
    );
  }
  checkValues(server.headers, grant.secrets, {
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
  const grant = grants.find(
    (g) => g.command === server.command && sameArgs(g.args ?? [], server.args),
  );
  if (!grant) {
    throw notAllowed(
      `Node '${nodeId}' gives the agent stdio MCP server '${server.name}' (${commandText(server.command, server.args)}), which the host does not allow.`,
      `Allowed MCP server commands: ${grants.map((g) => commandText(g.command, g.args ?? [])).join('; ') || '(none)'}.`,
    );
  }
  checkValues(server.env, grant.secrets, {
    nodeId,
    server: server.name,
    what: 'environment variable',
  });
}

/** Every header or environment value must be a `$secret` the grant binds to that name. */
function checkValues(
  values: ReadonlyArray<NamedValue>,
  secrets: Readonly<Record<string, string>> | undefined,
  where: {
    readonly nodeId: string;
    readonly server: string;
    readonly what: 'header' | 'environment variable';
  },
): void {
  const { nodeId, server, what } = where;
  for (const entry of values) {
    if (isSecret(entry.value) && secrets?.[entry.value.$secret] === entry.name) {
      continue;
    }
    const granted = Object.entries(secrets ?? {})
      .filter(([, name]) => name === entry.name)
      .map(([secret]) => `{ "$secret": "${secret}" }`);
    throw notAllowed(
      `Node '${nodeId}' sets ${what} '${entry.name}' on MCP server '${server}' to a value the host does not allow.`,
      granted.length > 0
        ? `'${entry.name}' takes only ${granted.join(' or ')}.`
        : `The host binds no secret to ${what} '${entry.name}'.`,
    );
  }
}

/**
 * The URL as patterns see it, or undefined when it is not http(s) or carries a
 * user or password (`http://localhost:1@evil.example/` would otherwise match
 * `http://localhost:*`).
 */
function plainUrl(url: string): string | undefined {
  if (!URL.canParse(url)) {
    return undefined;
  }
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return undefined;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return undefined;
  }
  return parsed.href;
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

//#endregion

//#region Secrets

async function resolveServers(
  servers: ReadonlyArray<WorkflowMcpServer>,
  ctx: Context,
): Promise<ReadonlyArray<AcpMcpServer>> {
  const resolver = harnessInternal<SecretResolver>(ctx.harness, 'secrets');
  if (!resolver) {
    throw new NoeticConfigError({
      code: 'CONNECTION_INVALID',
      message: 'An MCP server uses a $secret but the harness has no secret resolver.',
      hint: 'Set `environment.secrets` on the AgentHarness to resolve secret names.',
    });
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
