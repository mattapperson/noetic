/**
 * Recognizes an agent's permission request for one of the bridged Noetic tools.
 *
 * A bridged tool is gated by the same steering and `needsApproval` checks as
 * in `callModel`, when the call reaches the bridge. The agent's own
 * permission request is a second gate `callModel` never has, so it is
 * answered `allow` without consulting the step's ACP permission policy.
 *
 * Because that skips the policy, each agent is recognized only by fields its
 * own adapter sets, never by a title alone: some agents title a call with
 * text the model wrote (a subagent's description), which could spell a
 * bridged tool's name. An agent with no such field gets no automatic answer;
 * its requests go to the step's policy like any other.
 */

import type {
  AcpPermissionOption,
  AcpRequestPermissionRequest,
  AcpToolHost,
} from '@noetic-tools/types';
import { bridgedToolTitles, geminiToolNameMatches } from '@noetic-tools/types';

//#region Types

type ToolCallUpdate = AcpRequestPermissionRequest['toolCall'];

/**
 * True when a permission request is for one of the host's tools. `announced`
 * is the agent's earlier `tool_call` update for the same id.
 * @public
 */
export type BridgedPermissionCheck = (
  request: AcpRequestPermissionRequest,
  host: AcpToolHost,
  announced: ToolCallUpdate | undefined,
) => boolean;

//#endregion

//#region Helpers

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

/** The exact titles `form` gives the host's tools. */
function titlesOf(host: AcpToolHost, form: number): ReadonlySet<string> {
  return new Set(
    host.tools.flatMap((tool) => bridgedToolTitles(host.serverName, tool.name)[form] ?? []),
  );
}

const CLAUDE_FORM = 0;
const CODEX_FORM = 1;

//#endregion

//#region Public API

/**
 * Claude Code names the tool it runs in `_meta.claudeCode.toolName`, and the
 * MCP server in `_meta.claudeCode.mcpServer.name` — both set by its adapter,
 * not the model.
 * @public
 */
export const claudeBridgedPermission: BridgedPermissionCheck = (request, host) => {
  const claudeCode = recordOf(recordOf(request.toolCall._meta)?.claudeCode);
  const toolName = claudeCode?.toolName;
  return (
    recordOf(claudeCode?.mcpServer)?.name === host.serverName &&
    typeof toolName === 'string' &&
    titlesOf(host, CLAUDE_FORM).has(toolName)
  );
};

/**
 * Codex marks an MCP approval with `_meta.is_mcp_tool_approval` and sends no
 * title; the `tool_call` it announced for the same id carries
 * `_meta.is_mcp_tool_call` and the title `mcp.<server>.<tool>`, which Codex
 * builds from the server and tool it is calling.
 * @public
 */
export const codexBridgedPermission: BridgedPermissionCheck = (request, host, announced) => {
  const title = announced?.title;
  return (
    recordOf(request._meta)?.is_mcp_tool_approval === true &&
    recordOf(announced?._meta)?.is_mcp_tool_call === true &&
    typeof title === 'string' &&
    titlesOf(host, CODEX_FORM).has(title)
  );
};

/**
 * Gemini CLI titles a call with display text, but builds its id from the
 * registered tool name: `mcp_<server>_<tool>__call_<n>`.
 * @public
 */
export const geminiBridgedPermission: BridgedPermissionCheck = (request, host) =>
  host.tools.some((tool) =>
    geminiToolNameMatches(host.serverName, tool.name, request.toolCall.toolCallId),
  );

/** The option that allows the call once, falling back to any allow option. */
export function allowOnceOption(
  options: ReadonlyArray<AcpPermissionOption>,
): AcpPermissionOption | undefined {
  return (
    options.find((option) => option.kind === 'allow_once') ??
    options.find((option) => option.kind === 'allow_always')
  );
}

//#endregion
