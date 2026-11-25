/**
 * The live reattach test's host: real presets, and one noetic tool, `echo`,
 * that answers with the mark of the host that served it.
 */

import type { AcpAgent, AcpClientHost, AcpToolHost } from '@noetic-tools/types';
import { claudeCode, codex } from '../../src/agents';
import { MemoryFs, RecordingShell } from '../_helpers';

export const LIVE_AGENTS = {
  'claude-code': claudeCode,
  codex,
} as const;

export type LiveAgentId = keyof typeof LIVE_AGENTS;

export function isLiveAgentId(id: string): id is LiveAgentId {
  return Object.hasOwn(LIVE_AGENTS, id);
}

export function liveAgent(id: LiveAgentId): AcpAgent {
  return LIVE_AGENTS[id]();
}

function textOf(args: unknown): string {
  if (typeof args !== 'object' || args === null) {
    return '';
  }
  const text = Reflect.get(args, 'text');
  return typeof text === 'string' ? text : '';
}

/** A host serving `echo`, which records each call and answers `echo[<mark>]:<text>`. */
export function echoHost(mark: string, calls: string[], cwd: string): AcpClientHost {
  const tools: AcpToolHost = {
    serverName: 'noetic',
    tools: [
      {
        name: 'echo',
        description: 'Echoes the text back. Always use it when asked to echo.',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
            },
          },
          required: [
            'text',
          ],
        },
      },
    ],
    call: async (call) => {
      const text = textOf(call.args);
      calls.push(text);
      return {
        output: `echo[${mark}]:${text}`,
        isError: false,
      };
    },
  };
  return {
    cwd,
    threadId: mark,
    fs: new MemoryFs(),
    shell: new RecordingShell(),
    permissions: {
      default: 'allow',
    },
    tools,
    onSessionUpdate: () => undefined,
  };
}

export function askToEcho(word: string): string {
  return `Call the echo tool from the noetic MCP server with text "${word}". Then reply with exactly what it returned and nothing else.`;
}
