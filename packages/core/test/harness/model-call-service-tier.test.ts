/**
 * `callModel` forwards `params.serviceTier` to the OpenRouter client and
 * reports the tier the provider served — never an echo of the requested one.
 */

import { describe, expect, it } from 'bun:test';
import { frameworkCast } from '@noetic-tools/types';
import { AgentHarness } from '../../src/harness/agent-harness';
import { makeMessage } from '../_helpers';

//#region Fakes

/** Records each request and answers with one message, served on `servedTier`. */
class RecordingClient {
  requests: Record<string, unknown>[] = [];

  constructor(private readonly servedTier: string | undefined) {}

  callModel(request: Record<string, unknown>): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<unknown>;
  } {
    this.requests.push(request);
    return {
      async *getFullResponsesStream() {},
      getResponse: async () => ({
        id: 'resp-1',
        status: 'completed',
        serviceTier: this.servedTier,
        output: [
          {
            id: 'msg-1',
            status: 'completed',
            type: 'message',
            role: 'assistant',
            content: [
              {
                type: 'output_text',
                text: 'ok',
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

function harnessWith(client: RecordingClient): AgentHarness<Record<string, never>> {
  const harness = new AgentHarness({
    name: 'tier',
    params: {},
  });
  frameworkCast<{
    llm: {
      client: unknown;
    };
  }>(harness).llm.client = client;
  return harness;
}

//#endregion

describe('callModel service tier', () => {
  it('forwards the requested tier and reports the served tier', async () => {
    const client = new RecordingClient('priority');
    const harness = harnessWith(client);

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'hi'),
      ],
      params: {
        serviceTier: 'ultrafast',
      },
      ctx: harness.createContext(),
    });

    expect(client.requests[0]?.serviceTier).toBe('ultrafast');
    expect(response.serviceTier).toBe('priority');
  });

  it('leaves both sides unset when no tier is requested or reported', async () => {
    const client = new RecordingClient(undefined);
    const harness = harnessWith(client);

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'hi'),
      ],
      ctx: harness.createContext(),
    });

    expect(client.requests[0]?.serviceTier).toBeUndefined();
    expect('serviceTier' in response).toBe(false);
  });
});
