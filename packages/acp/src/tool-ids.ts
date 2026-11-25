/**
 * How each agent names its own tools on a call's update, so a call carries
 * the tool it is to (`toolId`, `toolServer`) rather than only its title
 * (spec 27 § Output → harness events). One reader per agent, set by its
 * preset as `AcpAgent.toolIdOf`.
 */

import type { AcpToolCallUpdate, ToolIdentity } from '@noetic-tools/types';

//#region Helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Claude Code names an MCP tool `mcp__<server>__<tool>`. */
const CLAUDE_MCP = /^mcp__(.+?)__(.+)$/;

/** Codex names an MCP tool `mcp.<server>.<tool>` in a call's title. */
const CODEX_MCP = /^mcp\.([^.\s]+)\.([^.\s]+)$/;

function mcpIdentity(pattern: RegExp, name: string): ToolIdentity | undefined {
  const match = pattern.exec(name);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return {
    id: match[2],
    server: match[1],
  };
}

//#endregion

//#region Public API

/**
 * Claude Code (claude-agent-acp): the tool's name in `_meta.claudeCode.toolName`
 * — `Read`, `Bash`, or an MCP tool's `mcp__<server>__<tool>`.
 * @public
 */
export function claudeToolId(update: AcpToolCallUpdate): ToolIdentity | undefined {
  const meta = update._meta;
  const claude = isRecord(meta) && isRecord(meta.claudeCode) ? meta.claudeCode : undefined;
  const name = text(claude?.toolName);
  if (!name) {
    return undefined;
  }
  return (
    mcpIdentity(CLAUDE_MCP, name) ?? {
      id: name,
    }
  );
}

/**
 * Codex (codex-acp): an MCP call's `rawInput` `{ server, tool }`, flagged by
 * `_meta.is_mcp_tool_call`, or its `mcp.<server>.<tool>` title. Codex names
 * its own tools by title only.
 * @public
 */
export function codexToolId(update: AcpToolCallUpdate): ToolIdentity | undefined {
  const input = isRecord(update.rawInput) ? update.rawInput : undefined;
  const server = text(input?.server);
  const tool = text(input?.tool);
  if (update._meta?.is_mcp_tool_call === true && server && tool) {
    return {
      id: tool,
      server,
    };
  }
  const title = text(update.title);
  return title ? mcpIdentity(CODEX_MCP, title) : undefined;
}

//#endregion
