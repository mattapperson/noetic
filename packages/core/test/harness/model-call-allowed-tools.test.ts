/**
 * A `callModel` request always sends its full tool list and narrows it with an
 * `allowed_tools` tool choice, so the tool prefix stays the same across steps.
 * The harness-owned tool loop still runs only tools from the allowed subset — a
 * call naming any other tool is answered as unknown.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ServerToolSpec, Tool } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { makeMessage } from '../_helpers';

//#region Fakes

/** A converted client tool (`function`) or a `serverTool()` wrapper (`config`). */
interface WireTool {
  function?: {
    name: string;
  };
  config?: {
    type: string;
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
  return frameworkCast<WireTool[]>(request?.tools ?? []).map(
    (t) => t.function?.name ?? t.config?.type ?? '',
  );
}

async function runWith(
  client: ScriptedClient,
  calls: string[],
  restriction: {
    allowedToolNames?: string[];
    serverTools?: ServerToolSpec[];
  },
) {
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
    allowedToolNames: restriction.allowedToolNames,
    _serverTools: restriction.serverTools,
    ctx: harness.createContext(),
  });
}

const ONLY_A = {
  allowedToolNames: [
    'a',
  ],
};

//#endregion

describe('callModel tool restriction', () => {
  it('sends the full tool set with an allowed_tools choice on every round', async () => {
    const calls: string[] = [];
    const client = new ScriptedClient('a');

    const response = await runWith(client, calls, ONLY_A);

    expect(client.requests).toHaveLength(2);
    for (const request of client.requests) {
      expect(wireToolNames(request)).toEqual([
        'a',
        'b',
      ]);
      expect(request.toolChoice).toEqual({
        type: 'allowed_tools',
        mode: 'auto',
        tools: [
          {
            type: 'function',
            name: 'a',
          },
        ],
      });
    }
    expect(calls).toEqual([
      'a',
    ]);
    const output = response.items.find((item) => item.type === 'function_call_output');
    assert(output?.type === 'function_call_output');
    expect(output.output).toBe('a ran');
  });

  it('sends the same tool list and no tool choice when the call is unrestricted', async () => {
    const calls: string[] = [];
    const client = new ScriptedClient('b');

    await runWith(client, calls, {});

    expect(wireToolNames(client.requests[0])).toEqual([
      'a',
      'b',
    ]);
    expect(client.requests[0]?.toolChoice).toBeUndefined();
    expect(calls).toEqual([
      'b',
    ]);
  });

  it('lists the server tools as allowed alongside the allowed client tools', async () => {
    const client = new ScriptedClient('a');

    await runWith(client, [], {
      ...ONLY_A,
      serverTools: [
        {
          type: 'openrouter:web_search',
        },
      ],
    });

    expect(wireToolNames(client.requests[0])).toEqual([
      'a',
      'b',
      'openrouter:web_search',
    ]);
    expect(client.requests[0]?.toolChoice).toEqual({
      type: 'allowed_tools',
      mode: 'auto',
      tools: [
        {
          type: 'function',
          name: 'a',
        },
        {
          type: 'openrouter:web_search',
        },
      ],
    });
  });

  it('sends no client tools when no requested name is allowed', async () => {
    const client = new ScriptedClient('a');

    await runWith(client, [], {
      allowedToolNames: [
        'missing',
      ],
    });

    expect(client.requests[0]?.tools).toBeUndefined();
    expect(client.requests[0]?.toolChoice).toBeUndefined();
  });

  it('answers a call to a tool outside the allowed set as unknown without running it', async () => {
    const calls: string[] = [];
    const client = new ScriptedClient('b');

    const response = await runWith(client, calls, ONLY_A);

    expect(calls).toEqual([]);
    const output = response.items.find((item) => item.type === 'function_call_output');
    assert(output?.type === 'function_call_output');
    expect(output.output).toBe("Error: unknown tool 'b'");
  });
});
