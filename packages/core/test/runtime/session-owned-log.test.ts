/**
 * The session-owned item log: one `ItemLogImpl` per thread, shared by reference
 * with every turn's context. Two semantics the old copy-out/copy-back history
 * gave for free must be preserved explicitly:
 *
 *  1. A FAILED turn leaves no trace. With a single shared log, the turn's
 *     partial items (its input, anything appended before the failure) are
 *     already in the log when the error hits — the runner rolls back to a
 *     watermark captured at turn start instead of relying on never-copied-back.
 *  2. History accumulates across turns by identity: turn N's context reads and
 *     appends the same log turns 1..N-1 wrote, with no per-turn array spreads.
 */

import { describe, expect, it } from 'bun:test';
import type { ContextData } from '@noetic-tools/context';
import type { CallModelRequest, Item, LLMResponse, Step } from '@noetic-tools/types';
import { AgentHarness } from '../../src/harness/agent-harness';
import { textOnlyResponse } from '../_helpers';

const echoStep: Step<ContextData, string, string> = {
  kind: 'callModel',
  id: 'echo',
  model: 'test/echo',
  tools: [],
};

function itemTexts(items: ReadonlyArray<Item>): string[] {
  return items.flatMap((item) =>
    item.type === 'message'
      ? item.content.flatMap((part) =>
          part.type === 'input_text' || part.type === 'output_text'
            ? [
                part.text,
              ]
            : [],
        )
      : [],
  );
}

describe('session-owned item log', () => {
  it('history accumulates across turns on one thread', async () => {
    const captured: string[][] = [];
    const harness = new AgentHarness({
      name: 'test',
      agentGraph: echoStep,
      params: {},
      _testCallModel: async (request: CallModelRequest): Promise<LLMResponse> => {
        captured.push(itemTexts(request.items));
        return textOnlyResponse(`reply ${captured.length}`);
      },
    });

    await harness.execute('first');
    await harness.getAgentResponse();
    await harness.execute('second');
    await harness.getAgentResponse();

    expect(captured).toHaveLength(2);
    // Turn 2 saw turn 1's input AND its reply — the shared log carried both
    // forward without any copy-back step.
    expect(captured[1]).toContain('first');
    expect(captured[1]).toContain('reply 1');
    expect(captured[1]).toContain('second');
  });

  it('a failed turn leaves no trace in the session history', async () => {
    const captured: string[][] = [];
    let fail = true;
    const harness = new AgentHarness({
      name: 'test',
      agentGraph: echoStep,
      params: {},
      _testCallModel: async (request: CallModelRequest): Promise<LLMResponse> => {
        captured.push(itemTexts(request.items));
        if (fail) {
          throw new Error('model exploded');
        }
        return textOnlyResponse('recovered');
      },
    });

    await harness.execute('doomed turn');
    await expect(harness.getAgentResponse()).rejects.toThrow('model exploded');

    fail = false;
    await harness.execute('next turn');
    const response = await harness.getAgentResponse();
    expect(response.text).toBe('recovered');

    // The recovery turn's request contains neither the failed turn's input nor
    // any partial output — the rollback restored the pre-turn watermark.
    expect(captured).toHaveLength(2);
    expect(captured[1]).toContain('next turn');
    expect(captured[1]).not.toContain('doomed turn');
  });

  it('the failure rollback preserves earlier successful turns', async () => {
    const captured: string[][] = [];
    let fail = false;
    const harness = new AgentHarness({
      name: 'test',
      agentGraph: echoStep,
      params: {},
      _testCallModel: async (request: CallModelRequest): Promise<LLMResponse> => {
        captured.push(itemTexts(request.items));
        if (fail) {
          throw new Error('model exploded');
        }
        return textOnlyResponse(`reply ${captured.length}`);
      },
    });

    await harness.execute('good turn');
    await harness.getAgentResponse();

    fail = true;
    await harness.execute('bad turn');
    await expect(harness.getAgentResponse()).rejects.toThrow('model exploded');

    fail = false;
    await harness.execute('final turn');
    await harness.getAgentResponse();

    const last = captured[captured.length - 1];
    // Turn 1's exchange survived the failed turn's rollback...
    expect(last).toContain('good turn');
    expect(last).toContain('reply 1');
    // ...while turn 2's input was erased.
    expect(last).not.toContain('bad turn');
    expect(last).toContain('final turn');
  });
});
