/**
 * What a document's `acp-agent` nodes may ask of an agent. A node's
 * `permissions`, `cwd`, `clientCapabilities` and `session` decide what the
 * agent can do on the host — `terminal` alone hands it a shell — so a document
 * a host did not write may ask only for what the host's `acp` allowlist grants
 * that agent (spec 26 § ACP agents).
 */

import type {
  AcpAgent,
  AcpAgentGrant,
  AcpAllowlist,
  AcpCapabilityGrant,
  AcpKeepAlive,
  AcpPermissionGrant,
  AcpSessionPolicy,
  WorkflowDocument,
  WorkflowNode,
} from '@noetic-tools/types';
import { NoeticConfigError, walkWorkflow } from '@noetic-tools/types';
import type { HydrationContext } from './workflow-hydrator';

//#region Types

type AcpAgentNode = Extract<
  WorkflowNode,
  {
    kind: 'acp-agent';
  }
>;

type PermissionRule = NonNullable<AcpPermissionGrant['allow']>[number];

type Capability = keyof AcpCapabilityGrant;

type AcpBounds = NonNullable<HydrationContext['acpBounds']>;

//#endregion

//#region Public API

/**
 * Checks every `acp-agent` node against the grant for its agent. Inline
 * subflows count; named refs resolve from the host's own registry and are not
 * checked.
 *
 * @throws `NoeticConfigError` `CONNECTION_NOT_ALLOWED` for a permission, `cwd`, client capability or session setting the grant does not allow.
 */
export function checkAcpAgents(
  doc: WorkflowDocument,
  grants: AcpAllowlist | undefined,
  harnessCwd: string,
): void {
  for (const node of walkWorkflow(doc.root)) {
    if (node.kind !== 'acp-agent') {
      continue;
    }
    const grant = grantFor(grants, node.agent);
    checkPermissions(node, grant.permissions);
    checkCwd(node, grant.cwd ?? harnessCwd);
    checkCapabilities(node, capabilityCeiling(grant));
    checkSession(node, grant);
  }
}

/** A new namespace for one run of a document's sessions. */
export function acpBounds(grants: AcpAllowlist | undefined): AcpBounds {
  return {
    grants: grants ?? {},
    sessionScope: `document-${crypto.randomUUID()}`,
  };
}

/**
 * The node's settings as its step runs them. An omitted capability takes the
 * grant's value rather than the protocol client's default of on, and a
 * `session.reuse` key moves into the document's namespace.
 */
export function boundedAcpSettings(
  node: AcpAgentNode,
  bounds: AcpBounds,
): {
  clientCapabilities: Required<AcpCapabilityGrant>;
  session: AcpSessionPolicy | undefined;
} {
  const ceiling = capabilityCeiling(grantFor(bounds.grants, node.agent));
  const capability = (name: Capability): boolean =>
    node.clientCapabilities?.[name] ?? ceiling[name] === true;
  const reuse = node.session?.reuse;
  return {
    clientCapabilities: {
      readTextFile: capability('readTextFile'),
      writeTextFile: capability('writeTextFile'),
      terminal: capability('terminal'),
    },
    session: reuse
      ? {
          ...node.session,
          reuse: `${bounds.sessionScope}/${reuse}`,
        }
      : node.session,
  };
}

/** The planner's view of the agents it may run and the most it may ask of each. */
export function acpPrompt(
  agents: ReadonlyMap<string, AcpAgent> | undefined,
  grants: AcpAllowlist | undefined,
  harnessCwd: string,
): string {
  const ids = [
    ...(agents?.keys() ?? []),
  ];
  if (ids.length === 0) {
    return '\nNo ACP agents are available: do not emit acp-agent nodes.';
  }
  const lines = ids.map((id) => agentLine(id, grantFor(grants, id), harnessCwd));
  return `\nACP agents an acp-agent node may run (no others), and the most a node may ask of each:
${lines.join('\n')}`;
}

//#endregion

//#region Checks

const NO_GRANT: AcpAgentGrant = {};

const DEFAULT_CAPABILITIES: AcpCapabilityGrant = {
  readTextFile: true,
};

const CAPABILITIES: ReadonlyArray<Capability> = [
  'readTextFile',
  'writeTextFile',
  'terminal',
];

const KEEP_ALIVE_ORDER: Readonly<Record<AcpKeepAlive, number>> = {
  step: 0,
  run: 1,
  harness: 2,
};

function grantFor(grants: AcpAllowlist | undefined, agent: string): AcpAgentGrant {
  return grants && Object.hasOwn(grants, agent) ? (grants[agent] ?? NO_GRANT) : NO_GRANT;
}

function capabilityCeiling(grant: AcpAgentGrant): AcpCapabilityGrant {
  return grant.clientCapabilities ?? DEFAULT_CAPABILITIES;
}

function checkPermissions(node: AcpAgentNode, grant: AcpPermissionGrant | undefined): void {
  const policy = node.permissions;
  if (!policy) {
    return;
  }
  if (policy.default === 'allow' && grant?.default !== 'allow') {
    throw notAllowed(node, 'permissions.default "allow"', 'Leave `default` out, which denies.');
  }
  if (policy.persist && !grant?.persist) {
    throw notAllowed(node, 'permissions.persist', 'Leave `persist` out.');
  }
  for (const rule of policy.allow ?? []) {
    if (!(grant?.allow ?? []).some((ceiling) => covers(ceiling, rule))) {
      throw notAllowed(
        node,
        `the permissions.allow rule ${JSON.stringify(rule)}`,
        `Allow only within ${JSON.stringify(grant?.allow ?? [])}.`,
      );
    }
  }
}

/**
 * Whether every tool call `rule` matches, `ceiling` matches too. Titles match
 * as case-insensitive substrings, so a title containing the ceiling's title
 * matches only calls the ceiling's title matches.
 */
function covers(ceiling: PermissionRule, rule: PermissionRule): boolean {
  if (ceiling.kind !== undefined && ceiling.kind !== rule.kind) {
    return false;
  }
  if (ceiling.title === undefined) {
    return true;
  }
  return rule.title?.toLowerCase().includes(ceiling.title.toLowerCase()) === true;
}

function checkCwd(node: AcpAgentNode, root: string): void {
  if (node.cwd === undefined || isUnder(node.cwd, root)) {
    return;
  }
  throw notAllowed(
    node,
    `cwd ${JSON.stringify(node.cwd)}`,
    `Use ${root} or an absolute directory under it, written without '.', '..' or repeated '/'.`,
  );
}

/**
 * Lexical, with no `node:path`, so core stays runtime-neutral: `path` must
 * already be absolute and plain, so no `..` can walk it back out of `root`.
 */
function isUnder(path: string, root: string): boolean {
  if (!path.startsWith('/') || path.includes('\\')) {
    return false;
  }
  const segments = path === '/' ? [] : path.slice(1).split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return false;
  }
  const base = root.length > 1 && root.endsWith('/') ? root.slice(0, -1) : root;
  return path === base || path.startsWith(base === '/' ? '/' : `${base}/`);
}

function checkCapabilities(node: AcpAgentNode, ceiling: AcpCapabilityGrant): void {
  for (const name of CAPABILITIES) {
    if (node.clientCapabilities?.[name] === true && ceiling[name] !== true) {
      throw notAllowed(
        node,
        `clientCapabilities.${name}`,
        `Leave \`${name}\` out or set it to false.`,
      );
    }
  }
}

function checkSession(node: AcpAgentNode, grant: AcpAgentGrant): void {
  const longest = grant.session?.keepAlive ?? 'run';
  const keepAlive = node.session?.keepAlive ?? 'step';
  if (KEEP_ALIVE_ORDER[keepAlive] > KEEP_ALIVE_ORDER[longest]) {
    throw notAllowed(
      node,
      `session.keepAlive "${keepAlive}"`,
      `Keep the session alive no longer than "${longest}".`,
    );
  }
  if (node.session?.load !== undefined && !grant.session?.load) {
    throw notAllowed(node, 'session.load', 'Leave `load` out to start a new session.');
  }
}

function notAllowed(node: AcpAgentNode, what: string, hint: string): NoeticConfigError {
  return new NoeticConfigError({
    code: 'CONNECTION_NOT_ALLOWED',
    message: `Node '${node.id}' asks agent '${node.agent}' for ${what}, which the host does not allow.`,
    hint,
  });
}

//#endregion

//#region Prompt

function agentLine(id: string, grant: AcpAgentGrant, harnessCwd: string): string {
  const permissions = grant.permissions;
  const ceiling = capabilityCeiling(grant);
  const on = CAPABILITIES.filter((name) => ceiling[name] === true);
  return [
    `- ${JSON.stringify(id)}:`,
    `permissions default ${permissions?.default === 'allow' ? '"allow" or "deny"' : '"deny" only'},`,
    `"allow" rules only within ${JSON.stringify(permissions?.allow ?? [])},`,
    `${permissions?.persist ? '' : 'no '}"persist";`,
    `cwd ${JSON.stringify(grant.cwd ?? harnessCwd)} or a directory under it;`,
    `clientCapabilities ${on.length > 0 ? on.join(', ') : 'none'} (any other off);`,
    `session keepAlive up to ${JSON.stringify(grant.session?.keepAlive ?? 'run')}, ${grant.session?.load ? '"load" allowed' : 'no "load"'}`,
  ].join(' ');
}

//#endregion
