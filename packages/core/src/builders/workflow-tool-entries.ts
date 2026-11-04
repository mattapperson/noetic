/**
 * A node's `tools` entries as live step tools (spec 26 § Tools). `{ type }` is
 * a registered client tool or an `openrouter:*` server tool; `{ connection,
 * ops? }` picks a harness or turn connection's model tools; `{ mcp }` is an
 * MCP server the step attaches, built from the host's `mcp` allowlist. A
 * document never sets a connection's policy, and under a `connections`
 * allowlist a pick never reaches past the operations it grants.
 */

import type {
  ConnectionAllowlist,
  ConnectionConfig,
  ConnectionPick,
  McpAllowlist,
  Spawn,
  Step,
  StepToolEntry,
  Tool,
  WorkflowConnectionToolEntry,
  WorkflowDocument,
  WorkflowStepConnectionEntry,
  WorkflowToolEntry,
  WorkflowTypedToolEntry,
} from '@noetic-tools/types';
import { isServerToolSpec, NoeticConfigError, walkWorkflow } from '@noetic-tools/types';
import { setDocumentEntries } from './document-entries';
import type { ConnectionManifestEntries } from './workflow-connections';
import { globMatches } from './workflow-connections';
import { DOCUMENT_WHERE, documentServers, mcpEntry } from './workflow-mcp-servers';

//#region Types

/** What hydrating a node's `tools` needs from the host. */
export interface ToolEntryHosts {
  readonly tools: ReadonlyMap<string, Tool>;
  /** What the document may use of each connection; absent allows every connection. */
  readonly allowlist?: ConnectionAllowlist;
  readonly mcp?: McpAllowlist;
  /** Where a stdio `{ mcp }` server starts: the node's ACP agent's machine. Absent starts it here. */
  readonly spawn?: Spawn;
  /** The connections the node's document declares; its `{ mcp }` entries are the document's own servers. */
  readonly connections?: ConnectionManifestEntries;
}

//#endregion

//#region Public API

/**
 * The step tools a `callModel` or `acp-agent` node stands for. Under a
 * connections allowlist a node gets exactly what it lists, and a node with no
 * `tools` gets each granted connection with exactly its granted operations,
 * plus the MCP servers its document's `connections` attach — never every
 * connection the harness holds. Without an allowlist an empty list is no
 * list, and the step is offered what any step with no `tools` is.
 *
 * @throws `NoeticConfigError` as `stepTools`.
 */
export function nodeTools(
  node: {
    readonly id: string;
    readonly tools?: ReadonlyArray<WorkflowToolEntry>;
  },
  hosts: ToolEntryHosts,
): StepToolEntry[] | undefined {
  if (hosts.allowlist === undefined) {
    const tools = stepTools(node.id, node.tools ?? [], hosts);
    return tools.length > 0 ? tools : undefined;
  }
  if (node.tools === undefined) {
    return grantedPicks(hosts.allowlist, hosts.connections);
  }
  return stepTools(node.id, node.tools, hosts);
}

/**
 * The step tools a `callModel` node's `tools` entries stand for.
 *
 * @throws `NoeticConfigError` `UNKNOWN_TOOL_REFERENCE` for a tool the registry does not hold; the errors of `connectionEntries`.
 */
export function stepTools(
  nodeId: string,
  entries: ReadonlyArray<WorkflowToolEntry>,
  hosts: ToolEntryHosts,
): StepToolEntry[] {
  const typed = entries.filter(isTypedEntry);
  return [
    ...resolveTools(
      typed.filter((entry) => !isServerToolSpec(entry)).map((entry) => entry.type),
      hosts.tools,
    ),
    ...typed.filter(isServerToolSpec),
    ...connectionEntries(nodeId, entries.filter(isConnectionEntry), hosts),
  ];
}

/**
 * The connection entries and picks a node's `{ connection }` and `{ mcp }`
 * entries stand for. A stdio `{ mcp }` server starts through `hosts.spawn`
 * when given: where the node's ACP agent runs.
 *
 * @throws `NoeticConfigError` `CONNECTION_NOT_ALLOWED` for a server or operation the host does not grant; `CONNECTION_INVALID` when the host gives no `mcp.provider`.
 */
export function connectionEntries(
  nodeId: string,
  entries: ReadonlyArray<WorkflowStepConnectionEntry>,
  hosts: Pick<ToolEntryHosts, 'allowlist' | 'mcp' | 'spawn'>,
): Array<ConnectionPick | ConnectionConfig> {
  return entries.map((entry) =>
    'mcp' in entry
      ? mcpEntry(`Node '${nodeId}'`, entry.mcp, {
          allowlist: hosts.mcp,
          spawn: hosts.spawn,
        })
      : connectionPick(nodeId, entry, hosts.allowlist),
  );
}

/**
 * Records the `{ "mcp" }` entries of a document's `connections` on the step
 * built for it, so the turn attaches them when the document runs, by the
 * names the document gives them.
 *
 * @throws `NoeticConfigError` as `mcpEntry`.
 */
export function recordDocumentConnections(
  root: Step,
  doc: WorkflowDocument,
  mcp: McpAllowlist | undefined,
): void {
  setDocumentEntries(
    root,
    documentServers(doc).map((server) => ({
      name: server.name,
      config: mcpEntry(DOCUMENT_WHERE, server, {
        allowlist: mcp,
      }),
      scope: 'turn',
      where: 'document connections',
    })),
  );
}

/**
 * Checks every `{ connection }` tool entry against the host's allowlist: it
 * names an allowed connection, and each of its `ops` globs stays inside the
 * operations the allowlist grants. Without `ops` the pick takes exactly the
 * granted operations.
 *
 * @throws `NoeticConfigError` `CONNECTION_NOT_ALLOWED` for a connection or operation glob the allowlist does not grant.
 */
export function checkToolConnections(doc: WorkflowDocument, allowlist: ConnectionAllowlist): void {
  for (const node of walkWorkflow(doc.root)) {
    if (node.kind !== 'callModel' && node.kind !== 'acp-agent') {
      continue;
    }
    for (const entry of node.tools ?? []) {
      if ('connection' in entry) {
        allowedOps(node.id, entry, allowlist);
      }
    }
  }
}

//#endregion

//#region Helpers

function grantedPicks(
  allowlist: ConnectionAllowlist,
  manifest: ConnectionManifestEntries | undefined,
): ConnectionPick[] {
  const granted = Object.entries(allowlist).map(
    ([connection, entry]): ConnectionPick => ({
      kind: 'connection-pick',
      connection,
      ops: entry.ops ?? [],
    }),
  );
  const own = Object.entries(manifest ?? {})
    .filter(([name, entry]) => entry.mcp !== undefined && !Object.hasOwn(allowlist, name))
    .map(
      ([connection]): ConnectionPick => ({
        kind: 'connection-pick',
        connection,
      }),
    );
  return [
    ...granted,
    ...own,
  ];
}

function isTypedEntry(entry: WorkflowToolEntry): entry is WorkflowTypedToolEntry {
  return 'type' in entry;
}

function isConnectionEntry(entry: WorkflowToolEntry): entry is WorkflowStepConnectionEntry {
  return !isTypedEntry(entry);
}

function connectionPick(
  nodeId: string,
  entry: WorkflowConnectionToolEntry,
  allowlist: ConnectionAllowlist | undefined,
): ConnectionPick {
  const ops = allowlist ? allowedOps(nodeId, entry, allowlist) : entry.ops;
  return {
    kind: 'connection-pick',
    connection: entry.connection,
    ...(ops
      ? {
          ops,
        }
      : {}),
  };
}

/**
 * The operation globs a pick may use under the allowlist: its own, each inside
 * a granted glob, or with none the granted ones.
 *
 * @throws `NoeticConfigError` `CONNECTION_NOT_ALLOWED` when the connection or a glob is not granted.
 */
function allowedOps(
  nodeId: string,
  entry: WorkflowConnectionToolEntry,
  allowlist: ConnectionAllowlist,
): ReadonlyArray<string> {
  const granted = allowlist[entry.connection]?.ops;
  if (!Object.hasOwn(allowlist, entry.connection)) {
    throw notAllowed(
      `Node '${nodeId}' lists the tools of connection '${entry.connection}', which the host does not allow.`,
      `Allowed connections: ${Object.keys(allowlist).join(', ') || '(none)'}.`,
    );
  }
  if (entry.ops === undefined) {
    return granted ?? [];
  }
  for (const glob of entry.ops) {
    // A glob read as plain text matches a granted glob only when every
    // operation it matches does too: its `*` can only meet a granted `*`.
    if ((granted ?? []).some((pattern) => globMatches(pattern, glob))) {
      continue;
    }
    throw notAllowed(
      `Node '${nodeId}' picks operations '${glob}' of '${entry.connection}', which the host does not allow.`,
      `Allowed operations: ${(granted ?? []).join(', ') || '(none)'}.`,
    );
  }
  return entry.ops;
}

function notAllowed(message: string, hint: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'CONNECTION_NOT_ALLOWED',
    message,
    hint,
  });
}

/** A complete sentence naming what is registered, for a hint. */
export function registeredSentence(noun: string, names: Iterable<string>): string {
  const list = [
    ...names,
  ];
  return list.length > 0 ? `Registered ${noun}: ${list.join(', ')}.` : `No ${noun} are registered.`;
}

/**
 * Resolves tool names against the registry.
 *
 * @throws `NoeticConfigError` `UNKNOWN_TOOL_REFERENCE` for a name it does not hold.
 */
export function resolveTools(
  names: ReadonlyArray<string>,
  registry: ReadonlyMap<string, Tool>,
): Tool[] {
  return names.map((name) => {
    const tool = registry.get(name);
    if (!tool) {
      throw new NoeticConfigError({
        code: 'UNKNOWN_TOOL_REFERENCE',
        message: `Tool '${name}' referenced in workflow is not registered.`,
        hint: `Register '${name}' in HydrationContext.tools before hydrating. ${registeredSentence('tools', registry.keys())}`,
      });
    }
    return tool;
  });
}

//#endregion
