/**
 * A `callModel` request that narrows its tools with `allowedToolNames` sends
 * only the allowed subset, and the harness-owned tool loop runs only tools
 * from that subset — a call naming any other tool is answered as unknown.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { Tool } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { makeMessage } from '../_helpers';

//#region Fakes

interface WireTool {
  function: {
    name: string;
  };
}

/** Records each request; round one calls `toolName`, round two answers. */
class ScriptedClient {
  requests: Record<string, unknown>[] = [];

  constructor(private readonly toolName: string) {}

  callModel(request: Record<string, unknown>): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<unknown>;
  } {
    this.requests.push(request);
    const round = this.requests.length;
    return {
      async *getFullResponsesStream() {},
      getResponse: async () => ({
        id: `resp-${round}`,
        status: 'completed',
        output:
          round === 1
            ? [
                {
                  id: 'fc-1',
                  status: 'completed',
                  type: 'function_call',
                  callId: 'call-1',
                  name: this.toolName,
                  arguments: '{}',
                },
              ]
            : [
                {
                  id: 'msg-1',
                  status: 'completed',
                  type: 'message',
                  role: 'assistant',
                  content: [
                    {
                      type: 'output_text',
                      text: 'done',
                    },
                  ],
                },
              ],
        usage: {
          inputTokens: 5,
          outputTokens: 2,
        },
      }),
    };
  }
}

function countingTool(name: string, calls: string[]): Tool {
  return tool({
    name,
    description: `tool ${name}`,
    input: z.object({}),
    output: z.string(),
    execute: async () => {
      calls.push(name);
      return `${name} ran`;
    },
  });
}

function wireToolNames(request: Record<string, unknown> | undefined): string[] {
  return frameworkCast<WireTool[]>(request?.tools ?? []).map((t) => t.function.name);
}

async function runWith(client: ScriptedClient, calls: string[]) {
  const harness = new AgentHarness({
    name: 'allowed-tools',
    params: {},
  });
  frameworkCast<{
    client: unknown;
  }>(harness).client = client;
  return harness.callModel({
    model: 'test/model',
    items: [
      makeMessage('user', 'go'),
    ],
    tools: [
      countingTool('a', calls),
      countingTool('b', calls),
    ],
    allowedToolNames: [
      'a',
    ],
    ctx: harness.createContext(),
  });
}

//#endregion

describe('callModel allowedToolNames', () => {
  it('sends only the allowed tools on every round and runs an allowed call', async () => {
    const calls: string[] = [];
    const client = new ScriptedClient('a');

    const response = await runWith(client, calls);

    expect(client.requests).toHaveLength(2);
    expect(wireToolNames(client.requests[0])).toEqual([
      'a',
    ]);
    expect(wireToolNames(client.requests[1])).toEqual([
      'a',
    ]);
    expect(calls).toEqual([
      'a',
    ]);
    const output = response.items.find((item) => item.type === 'function_call_output');
    assert(output?.type === 'function_call_output');
    expect(output.output).toBe('a ran');
  });

  it('answers a call to a tool outside the allowed set as unknown without running it', async () => {
    const calls: string[] = [];
    const client = new ScriptedClient('b');

    const response = await runWith(client, calls);

    expect(calls).toEqual([]);
    const output = response.items.find((item) => item.type === 'function_call_output');
    assert(output?.type === 'function_call_output');
    expect(output.output).toBe("Error: unknown tool 'b'");
  });
});
