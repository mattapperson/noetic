/**
 * Checks on the tools given to `step.acpAgent`, shared by the builder (for an
 * eager `tools` array) and the interpreter (for a getter, when the step runs).
 */

import type { AcpAgent, AcpMcpServer, ServerToolSpec, Tool } from '@noetic-tools/types';
import { isServerToolSpec, NoeticConfigError } from '@noetic-tools/types';
import { sanitizeToolNameForWire } from '../util/tool-name';

/** The MCP server name agents see the step's tools under; they prefix tool names with it. */
export const ACP_TOOL_SERVER_NAME = 'noetic';

/**
 * A user server named `noetic`, or `noetic_…`, would produce tool titles the
 * bridge's own could be mistaken for — and the agent's permission requests for
 * bridged tools are allowed without asking.
 */
export function assertNoReservedServerName(
  stepId: string,
  servers: ReadonlyArray<AcpMcpServer> | undefined,
): void {
  const clash = servers?.find((server) => /^noetic(_|$)/.test(server.name));
  if (!clash) {
    return;
  }
  throw new NoeticConfigError({
    code: 'ACP_TOOL_SERVER_NAME_CONFLICT',
    message: `step.acpAgent(${JSON.stringify(stepId)}) names one of its MCP servers '${clash.name}', which clashes with '${ACP_TOOL_SERVER_NAME}', the name its tools are served under.`,
    hint: `Rename that MCP server; '${ACP_TOOL_SERVER_NAME}' and names starting '${ACP_TOOL_SERVER_NAME}_' are reserved for the step's own tools.`,
  });
}

/** The agent can take tools only if its connection serves them. */
export function assertAgentTakesTools(stepId: string, agent: AcpAgent): void {
  if (agent.servesTools === true) {
    return;
  }
  throw new NoeticConfigError({
    code: 'ACP_TOOLS_UNSUPPORTED',
    message: `step.acpAgent(${JSON.stringify(stepId)}) gives tools to the '${agent.agentId}' agent, which cannot take them.`,
    hint: 'Use a preset that serves tools (claudeCode, codex, opencode, gemini), or `customAcpAgent({ tools: true })` for an agent on this machine that accepts MCP servers in session/new.',
  });
}

/**
 * Narrow to client tools, rejecting server tools (only a model provider can
 * run them) and names that reach the agent as the same wire name.
 */
export function checkedAcpTools(
  stepId: string,
  entries: ReadonlyArray<Tool | ServerToolSpec>,
): Tool[] {
  const owners = new Map<string, string>();
  return entries.map((entry) => {
    if (isServerToolSpec(entry)) {
      throw new NoeticConfigError({
        code: 'ACP_SERVER_TOOL',
        message: `step.acpAgent(${JSON.stringify(stepId)}) was given the server tool '${entry.type}', which only a model provider can run.`,
        hint: 'Pass only client tools built with tool() to an ACP step.',
      });
    }
    const wire = sanitizeToolNameForWire(entry.name);
    const owner = owners.get(wire);
    if (owner !== undefined) {
      throw new NoeticConfigError({
        code: 'ACP_TOOL_NAME_COLLISION',
        message: `step.acpAgent(${JSON.stringify(stepId)}) has tools '${owner}' and '${entry.name}', which both reach the agent as '${wire}'.`,
        hint: 'Tool names are reduced to letters, digits, `_` and `-` on the wire. Rename one of them.',
      });
    }
    owners.set(wire, entry.name);
    return entry;
  });
}
