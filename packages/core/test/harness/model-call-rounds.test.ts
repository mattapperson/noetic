/**
 * A step has no tool round cap (spec 02, No round cap): it keeps running tool rounds until the model answers
 * without calling a tool, however many rounds that takes.
 */

import { describe, expect, it } from 'bun:test';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { makeMessage } from '../_helpers';

/** Calls the tool `rounds` times, one call per round, then answers. */
class LongClient {
  requests = 0;

  constructor(private readonly rounds: number) {}

  callModel(): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<unknown>;
  } {
    this.requests += 1;
    const round = this.requests;
    const answer = round > this.rounds;
    return {
      async *getFullResponsesStream() {},
      getResponse: async () => ({
        id: `resp-${round}`,
        status: 'completed',
        output: answer
          ? [
              {
                id: `msg-${round}`,
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
            ]
          : [
              {
                id: `fc-${round}`,
                status: 'completed',
                type: 'function_call',
                callId: `call-${round}`,
                name: 'step',
                arguments: '{}',
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

describe('callModel tool rounds', () => {
  it('runs past the old 32-round cap until the model answers', async () => {
    const rounds = 60;
    let ran = 0;
    const client = new LongClient(rounds);
    const harness = new AgentHarness({
      name: 'long-rounds',
      params: {},
    });
    frameworkCast<{
      llm: {
        client: unknown;
      };
    }>(harness).llm.client = client;

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'go'),
      ],
      tools: [
        tool({
          name: 'step',
          description: 'one step of a long task',
          input: z.object({}),
          output: z.string(),
          execute: async () => {
            ran += 1;
            return 'ok';
          },
        }),
      ],
      ctx: harness.createContext(),
    });

    expect(ran).toBe(rounds);
    expect(client.requests).toBe(rounds + 1);
    expect(response.items.filter((item) => item.type === 'function_call_output')).toHaveLength(
      rounds,
    );
  });
});
