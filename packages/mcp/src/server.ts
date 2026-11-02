/**
 * The MCP server an ACP agent connects to for its Noetic tools.
 *
 * It only translates: `tools/list` reads the host's listing and `tools/call`
 * forwards to `host.call`, which runs the same pipeline a model's tool call
 * does. Nothing here knows how a Noetic tool executes.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AcpTool, AcpToolHost } from '@noetic-tools/types';

//#region Agent hints

/**
 * Claude Code reads these per-tool `_meta` keys. Without them it hides MCP
 * tools behind a ToolSearch step and saves large results to a file, so the
 * model would neither see the tools up front nor read their full output.
 */
const ALWAYS_LOAD = 'anthropic/alwaysLoad';
const MAX_RESULT_SIZE_CHARS = 'anthropic/maxResultSizeChars';
const UNBOUNDED_RESULT_CHARS = 1e9;

/**
 * Keys under which agents put their own id for a call in the request `_meta`.
 * Each equals the `toolCallId` of the agent's ACP `tool_call` for that call.
 */
const AGENT_CALL_ID_KEYS = [
  'claudecode/toolUseId',
  'callId',
] as const;

//#endregion

//#region Helpers

function toMcpTool(tool: AcpTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      ...tool.inputSchema,
    },
    ...(tool.title !== undefined
      ? {
          title: tool.title,
        }
      : {}),
    _meta: {
      [ALWAYS_LOAD]: true,
      [MAX_RESULT_SIZE_CHARS]: UNBOUNDED_RESULT_CHARS,
    },
  };
}

/** @public The agent's id for a call, read from the MCP request `_meta`. */
export function agentCallIdOf(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta) {
    return undefined;
  }
  for (const key of AGENT_CALL_ID_KEYS) {
    const value = meta[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function textResult(output: string, isError: boolean): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: output,
      },
    ],
    isError,
  };
}

//#endregion

//#region Public API

/**
 * Build an MCP server over the tool host. `getHost` is read on every request,
 * so a host rebound between turns takes effect without reconnecting.
 * @public
 */
export function createToolServer(getHost: () => AcpToolHost | undefined): Server {
  const server = new Server(
    {
      name: 'noetic',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (getHost()?.tools ?? []).map(toMcpTool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const host = getHost();
    if (!host) {
      return textResult(`Error: unknown tool '${request.params.name}'`, true);
    }
    const result = await host.call({
      name: request.params.name,
      args: request.params.arguments ?? {},
      agentCallId: agentCallIdOf(request.params._meta),
      signal: extra.signal,
    });
    return textResult(result.output, result.isError);
  });

  return server;
}

//#endregion
