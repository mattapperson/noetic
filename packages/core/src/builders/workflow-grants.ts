/**
 * What a host lets a document it did not write use: connections, ACP agents,
 * `runCode` subprocess adapters and MCP servers (spec 35 § What a document may
 * use, spec 26). One check holds a document to the grants; one prompt shows
 * them to the planner.
 */

import type {
  AcpAgent,
  AcpAllowlist,
  ConnectionAllowlist,
  McpAllowlist,
  RunCodeGrant,
  SecretResolver,
  WorkflowDocument,
} from '@noetic-tools/types';
import { acpPrompt, checkAcpAgents } from './workflow-acp-grants';
import { checkConnectionAllowlist } from './workflow-connections';
import { checkMcpServers, mcpPrompt } from './workflow-mcp-servers';
import { checkRunCode, runCodePrompt } from './workflow-run-code-grant';
import { checkToolConnections } from './workflow-tool-entries';

//#region Types

/** What the host grants a document. Undefined `acp`, `runCode` and `mcp` are their narrowest defaults. */
export interface Grants {
  connections: ConnectionAllowlist;
  /** The most `acp-agent` nodes may ask of each agent. */
  acp?: AcpAllowlist;
  /** The most `runCode` nodes may ask; undefined grants no adapter name. */
  runCode?: RunCodeGrant;
  /** The MCP servers the document may name; undefined grants none. */
  mcp?: McpAllowlist;
  /** The harness's working directory: an `acp-agent` node's `cwd` without an `acp` grant. */
  cwd: string;
}

/** What the planner is shown of one granted connection: the profiles it serves and its granted operations. */
export interface PlannerConnection {
  readonly profiles: Readonly<Record<string, string>>;
  readonly operations: ReadonlyArray<{
    readonly name: string;
    readonly inputSchema: unknown;
  }>;
}

/** What the harness has that the grants name. */
export interface Granted {
  /** Granted connections the harness serves right now, by name. */
  connections: ReadonlyMap<string, PlannerConnection>;
  /** ACP agent adapters by `agentId`. */
  acpAgents: ReadonlyMap<string, AcpAgent> | undefined;
}

//#endregion

//#region Public API

/**
 * Checks a document against the grants: its manifest and connection nodes,
 * the connections its `tools` pick, then its `acp-agent` nodes, `runCode`
 * nodes and MCP servers. The first refusal throws.
 *
 * @param secrets - The harness's secret resolver, which a `$secret` in an MCP server needs.
 * @throws `NoeticConfigError` `CONNECTION_NOT_ALLOWED` when the document asks for more than a grant gives.
 * @throws `NoeticConfigError` `CONNECTION_INVALID` when an MCP server uses a `$secret` and `secrets` is undefined.
 */
export function checkGrants(
  doc: WorkflowDocument,
  grants: Grants,
  secrets: SecretResolver | undefined,
): void {
  checkConnectionAllowlist(doc, grants.connections);
  checkToolConnections(doc, grants.connections);
  checkAcpAgents(doc, grants.acp, grants.cwd);
  checkRunCode(doc, grants.runCode);
  checkMcpServers(doc, grants.mcp, secrets);
}

/** The planner's view of the grants: only what the document may use, one paragraph per kind. */
export function grantsPrompt(grants: Grants, granted: Granted): string {
  return [
    connectionsPrompt(grants.connections, granted.connections),
    acpPrompt(granted.acpAgents, grants.acp, grants.cwd),
    runCodePrompt(grants.runCode),
    mcpPrompt(grants.mcp),
  ]
    .filter(Boolean)
    .join('\n\n');
}

//#endregion

//#region Helpers

/** The planner's view of the connections it may use: only the allowed ones, with their operations and argument schemas. */
function connectionsPrompt(
  allowlist: ConnectionAllowlist | undefined,
  known: ReadonlyMap<string, PlannerConnection>,
): string {
  const entries = Object.entries(allowlist ?? {});
  if (entries.length === 0) {
    return '\nNo connections are available: do not emit call, wait or verify nodes or a "connections" map.';
  }
  const lines = entries.map(([name, entry]) => connectionLine(name, entry, known.get(name)));
  return `\nConnections you may use (a document lists the ones it needs in a root "connections" map, e.g. "connections": { "app": { "profile": "<profile>", "from": "<connection>" } } — the version range is filled in for you — or { "events": [...] } for an event source):
${lines.join('\n')}
Connection nodes:
- { "kind": "call", "id": "<unique>", "connection": "<name>", "op": "<operation>", "args": { ... } } (run one operation; values may be { "$expr": "<JSONata on the input; $steps.<id> reads an earlier node's output>" }, { "$literal": ... }, or { "$secret": "<name>" })
- { "kind": "wait", "id": "<unique>", "connection": "<name>", "event": "<event>", "filter": "<JSONata test on { event, input }>", "around": [<steps>], "timeoutMs": <ms> } (listen, run around, then wait for the event)
- { "kind": "verify", "id": "<unique>", "subject": "<name>", "expect": [{ "<sense>": "<pattern>" }, ...], "never": [<matchers>], "act": [<steps>], "witnesses": ["<name>"], "close": { "until": "quiet"|"event"|"done"|"exit" } } (run act on the subject and check what was expected happened; act names operations by name)
Inside "around", "act" or a sequence's "steps", { "<operation>": { ...args } } is a call on the enclosing connection.
A callModel or acp-agent node may instead give the model a connection's tools with the "tools" entry { "connection": "<name>", "ops": [<optional; globs within the ops above>] }; this needs no "connections" map.`;
}

function connectionLine(
  name: string,
  entry: ConnectionAllowlist[string],
  known: PlannerConnection | undefined,
): string {
  const profiles = Object.keys(known?.profiles ?? {});
  const parts = [
    ...(profiles.length > 0
      ? [
          `profiles: ${profiles.join(', ')}`,
        ]
      : []),
    `ops: ${(entry.ops ?? []).join(', ') || '(none)'}`,
    `events: ${(entry.events ?? []).join(', ') || '(none)'}`,
  ];
  if (entry.setup) {
    parts.push(`setup fields: ${Object.keys(entry.setup).join(', ')}`);
  }
  if (entry.secrets) {
    parts.push(
      `secrets: ${Object.entries(entry.secrets)
        .map(([secret, field]) => `${secret} (only in ${field})`)
        .join(', ')}`,
    );
  }
  const schemas = (known?.operations ?? []).map(
    (op) => `    - ${op.name} args: ${JSON.stringify(op.inputSchema)}`,
  );
  return [
    `- ${name}: ${parts.join('; ')}`,
    ...schemas,
  ].join('\n');
}

//#endregion
