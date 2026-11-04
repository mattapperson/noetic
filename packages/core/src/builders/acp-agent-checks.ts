/**
 * Checks on the tools given to `step.acpAgent`, shared by the builder (for an
 * eager `tools` array) and the interpreter (for a getter, when the step runs).
 */

import type { AcpAgent, ServerToolSpec, Tool } from '@noetic-tools/types';
import { isServerToolSpec, NoeticConfigError } from '@noetic-tools/types';
import { sanitizeToolNameForWire } from '../util/tool-name';

/** The MCP server name agents see the step's tools under; they prefix tool names with it. */
export const ACP_TOOL_SERVER_NAME = 'noetic';

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

/** An agent that names the fix it is missing fails with it. */
export function assertAgentTakesTools(stepId: string, agent: AcpAgent): void {
  const refusal = agent.refusesTools;
  if (!refusal) {
    return;
  }
  throw new NoeticConfigError({
    code: refusal.code,
    message: `step.acpAgent(${JSON.stringify(stepId)}) gives tools to the '${agent.agentId}' agent, which cannot take them: ${refusal.reason}`,
    hint: refusal.hint,
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
