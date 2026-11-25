/**
 * An agent's questions held for a person (spec 27 § Questions the agent asks):
 * what identifies one across hosts, and an answer kept until the step ends.
 */

import { describe, expect, it } from 'bun:test';
import type { AcpCreateElicitationRequest, HeldCall } from '@noetic-tools/types';
import { AgentHarness } from '../../src/harness/agent-harness';
import { questionAsker } from '../../src/interpreter/acp-questions';

const REQUEST: AcpCreateElicitationRequest = {
  mode: 'form',
  sessionId: 's1',
  message: 'Which branch?',
  requestedSchema: {
    type: 'object',
    properties: {
      branch: {
        type: 'string',
      },
    },
  },
};

function harnessAnswering(shown: HeldCall[], answer: () => unknown): AgentHarness {
  return new AgentHarness({
    name: 'questions',
    params: {},
    onHeld: (call) => {
      shown.push(call);
      return {
        output: answer(),
      };
    },
  });
}

describe('questionAsker', () => {
  it('a question asked again with the same request id finds its kept answer: the person is asked once', async () => {
    const shown: HeldCall[] = [];
    const harness = harnessAnswering(shown, () => ({
      branch: 'main',
    }));
    const ctx = harness.createContext();
    const first = questionAsker({
      ctx,
      agentId: 'claude-code',
      stepId: 'step',
    });
    expect(
      await first.ask(REQUEST, {
        requestId: 7,
      }),
    ).toEqual({
      action: 'accept',
      content: {
        branch: 'main',
      },
    });
    // The host died before the agent got the answer: a new host, asked again by
    // the keeper with the agent's own id, takes the answer that is still there.
    const second = questionAsker({
      ctx,
      agentId: 'claude-code',
      stepId: 'step',
    });
    expect(
      await second.ask(REQUEST, {
        requestId: 7,
      }),
    ).toEqual({
      action: 'accept',
      content: {
        branch: 'main',
      },
    });
    expect(shown).toHaveLength(1);
  });

  it('an agent that asks again under an id this host already asked is asking a new question', async () => {
    const shown: HeldCall[] = [];
    let n = 0;
    const harness = harnessAnswering(shown, () => {
      n += 1;
      return {
        branch: n === 1 ? 'main' : 'next',
      };
    });
    const ctx = harness.createContext();
    const asker = questionAsker({
      ctx,
      agentId: 'claude-code',
      stepId: 'step',
    });
    const first = await asker.ask(REQUEST, {
      requestId: 4,
    });
    const second = await asker.ask(REQUEST, {
      requestId: 4,
    });
    expect(shown).toHaveLength(2);
    expect(first).not.toEqual(second);
  });

  it('two identical questions with different request ids are two questions', async () => {
    const shown: HeldCall[] = [];
    let n = 0;
    const harness = harnessAnswering(shown, () => {
      n += 1;
      return {
        branch: n === 1 ? 'main' : 'next',
      };
    });
    const ctx = harness.createContext();
    const asker = questionAsker({
      ctx,
      agentId: 'claude-code',
      stepId: 'step',
    });
    const first = await asker.ask(REQUEST, {
      requestId: 1,
    });
    const second = await asker.ask(REQUEST, {
      requestId: 2,
    });
    expect(shown).toHaveLength(2);
    expect(shown[0]?.callId).not.toBe(shown[1]?.callId);
    expect(first).toEqual({
      action: 'accept',
      content: {
        branch: 'main',
      },
    });
    expect(second).toEqual({
      action: 'accept',
      content: {
        branch: 'next',
      },
    });
  });

  it('release drops the step’s questions: asked again after, the person is asked again', async () => {
    const shown: HeldCall[] = [];
    const harness = harnessAnswering(shown, () => ({
      branch: 'main',
    }));
    const ctx = harness.createContext();
    const asker = questionAsker({
      ctx,
      agentId: 'claude-code',
      stepId: 'step',
    });
    await asker.ask(REQUEST, {
      requestId: 3,
    });
    await asker.release();
    await asker.ask(REQUEST, {
      requestId: 3,
    });
    expect(shown).toHaveLength(2);
  });

  it('without a request id, identical questions are told apart by their order', async () => {
    const shown: HeldCall[] = [];
    const harness = harnessAnswering(shown, () => ({
      branch: 'main',
    }));
    const ctx = harness.createContext();
    const asker = questionAsker({
      ctx,
      agentId: 'claude-code',
      stepId: 'step',
    });
    await asker.ask(REQUEST, {});
    await asker.ask(REQUEST, {});
    expect(shown.map((call) => call.callId.slice(-2))).toEqual([
      '#0',
      '#1',
    ]);
  });

  it('closes the form: an answer with a field the agent did not ask for stays held', async () => {
    const shown: HeldCall[] = [];
    const harness = new AgentHarness({
      name: 'closed',
      params: {},
      onHeld: (call) => {
        shown.push(call);
        return undefined;
      },
    });
    const ctx = harness.createContext();
    const asker = questionAsker({
      ctx,
      agentId: 'claude-code',
      stepId: 'step',
    });
    const asking = asker.ask(REQUEST, {
      requestId: 9,
    });
    for (let i = 0; i < 100 && shown.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const held = shown[0];
    if (!held) {
      throw new Error('the question was never held');
    }
    expect(held.question?.schema?.additionalProperties).toBe(false);
    const refused = await harness
      .resolveHeld(
        {
          executionId: ctx.id,
        },
        {
          callId: held.callId,
          output: {
            branch: 'main',
            extra: {
              nested: true,
            },
          },
        },
      )
      .catch((e: unknown) => e);
    expect(String(refused)).toContain('not a field of the form');
    await harness.resolveHeld(
      {
        executionId: ctx.id,
      },
      {
        callId: held.callId,
        action: 'deny',
      },
    );
    expect(await asking).toEqual({
      action: 'decline',
    });
  });
});
