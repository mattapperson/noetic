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

/**
 * Tools that run an ACP step, by the step they run (`acpAgentTool`). A step
 * never serves its own delegate: the agent calling it would wait on its own
 * session for ever.
 */
const delegates = new WeakMap<Tool, string>();

/** Record that `tool` runs the ACP step `stepId`. */
export function markAcpDelegate(tool: Tool, stepId: string): void {
  delegates.set(tool, stepId);
}

/** The ACP step `tool` runs, when it is an `acpAgentTool`. */
export function acpDelegateStepOf(tool: Tool): string | undefined {
  return delegates.get(tool);
}

/** The agent can take tools only if its connection serves them. */
export function assertAgentTakesTools(stepId: string, agent: AcpAgent): void {
  if (agent.servesTools === true) {
    return;
  }
  throw new NoeticConfigError({
    code: 'ACP_TOOLS_UNSUPPORTED',
    message: `step.acpAgent(${JSON.stringify(stepId)}) gives tools to the '${agent.agentId}' agent, which cannot take them.`,
    hint: 'A preset given a custom `transport` serves tools only with `tools: true`, for an agent that runs on this machine. Otherwise use claudeCode(), codex(), gemini(), or opencode(), or `customAcpAgent({ tools: true })` for an agent that accepts MCP servers in session/new. pi() cannot take tools.',
  });
}

/**
 * Narrow to client tools, as the agent will see them: the first tool of each
 * name wins, as in the `callModel` tool set. Server tools (only a model
 * provider can run them) and two names that reach the agent as the same wire
 * name are configuration errors.
 */
export function checkedAcpTools(
  stepId: string,
  entries: ReadonlyArray<Tool | ServerToolSpec>,
): Tool[] {
  const owners = new Map<string, string>();
  const tools: Tool[] = [];
  for (const entry of entries) {
    if (isServerToolSpec(entry)) {
      throw new NoeticConfigError({
        code: 'ACP_SERVER_TOOL',
        message: `step.acpAgent(${JSON.stringify(stepId)}) was given the server tool '${entry.type}', which only a model provider can run.`,
        hint: 'Pass only client tools built with tool() to an ACP step.',
      });
    }
    const wire = sanitizeToolNameForWire(entry.name);
    const owner = owners.get(wire);
    if (owner === entry.name) {
      continue;
    }
    if (owner !== undefined) {
      throw new NoeticConfigError({
        code: 'ACP_TOOL_NAME_COLLISION',
        message: `step.acpAgent(${JSON.stringify(stepId)}) has tools '${owner}' and '${entry.name}', which both reach the agent as '${wire}'.`,
        hint: 'Tool names are reduced to letters, digits, `_` and `-` on the wire. Rename one of them.',
      });
    }
    owners.set(wire, entry.name);
    tools.push(entry);
  }
  return tools;
}
