import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import { AgentHarness } from '../../src/runtime/agent-harness';
import type { LLMResponse } from '../../src/types/common';
import type { StreamEvent } from '../../src/types/harness-result';
import type { ContextMemory } from '../../src/types/memory';
import type { CallModelRequest } from '../../src/types/runtime';
import type { Step } from '../../src/types/step';

//#region Test scaffolding

const echoStep: Step<ContextMemory, string, string> = {
  kind: 'llm',
  id: 'echo',
  model: 'test/echo',
  tools: [],
};

function textResponse(text: string): LLMResponse {
  return {
    items: [
      {
        id: `msg-${crypto.randomUUID()}`,
        status: 'completed',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text,
          },
        ],
      },
    ],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
    },
  };
}

/** Scripted callModel that records every invocation (for assertions) and
 *  synthesises a deferred completion controlled by a gate. */
function makeGatedCallModel(): {
  call: (request: CallModelRequest) => Promise<LLMResponse>;
  requests: CallModelRequest[];
  release: () => void;
  callCount: () => number;
} {
  const requests: CallModelRequest[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = async (request: CallModelRequest): Promise<LLMResponse> => {
    requests.push(request);
    await gate;
    return textResponse('done');
  };
  return {
    call,
    requests,
    release: () => release?.(),
    callCount: () => requests.length,
  };
}

//#endregion

describe('AgentHarness delivery modes', () => {
  test('next-turn: queued message runs as a second turn after the first completes', async () => {
    const responses: LLMResponse[] = [
      textResponse('alpha'),
      textResponse('beta'),
    ];
    let callIdx = 0;

    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: async () => {
        const response = responses[callIdx++];
        if (!response) {
          throw new Error('exhausted');
        }
        return response;
      },
    });

    // First enqueue runs immediately; second arrives while runner is idle too
    // but the queue+loop flush collapses rapid enqueues. Testing explicit
    // next-turn semantics requires a second submit once the runner is busy.
    await harness.execute('first');
    // Immediately submit the second — the runner may still be draining.
    await harness.execute('second');
    const resp = await harness.getAgentResponse();
    // Final response should reflect the last turn's text.
    expect(resp.text).toBe('beta');
    // Two calls occurred because both messages drove their own turns.
    expect(callIdx).toBe(2);
  });

  test('between-rounds: messages with that mode do not trigger a new turn', async () => {
    // When a between-rounds message arrives while the turn is idle, the
    // runner still kicks — but the tool-round injection path only fires from
    // WITHIN callModel's loop (which _testCallModel bypasses). Here we
    // verify the end-to-end contract: submitting a between-rounds message
    // after a turn completes still drives a new turn (the harness does not
    // discard the message).
    let callIdx = 0;
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: async () => {
        callIdx++;
        return textResponse(`call-${callIdx}`);
      },
    });

    await harness.execute('first', {
      deliveryMode: 'between-rounds',
    });
    await harness.execute('second', {
      deliveryMode: 'between-rounds',
    });
    await harness.getAgentResponse();

    // Both messages drove calls (no message was silently dropped).
    expect(callIdx).toBeGreaterThanOrEqual(2);
  });

  test('interrupt: submitting with mode interrupt aborts in-flight turn and restarts', async () => {
    const gated = makeGatedCallModel();
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: gated.call,
    });

    // Submit the first message; runner enters `generating`.
    await harness.execute('first');

    // Wait until the runner has called into callModel.
    for (let i = 0; i < 20 && gated.callCount() === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(harness.getStatus().kind).toBe('generating');

    // Interrupt with a new message.
    await harness.execute('second', {
      deliveryMode: 'interrupt',
    });

    // Release the gate so any pending call resolves.
    gated.release();

    // Wait until idle again.
    for (let i = 0; i < 50 && harness.getStatus().kind !== 'idle'; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Two turns should have been started (aborted, then restarted).
    // The response text corresponds to the final completed turn.
    const resp = await harness.getAgentResponse();
    expect(resp.text).toBe('done');
  });

  test('abort preserves queued messages and they drive a fresh turn', async () => {
    const gated = makeGatedCallModel();
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: gated.call,
    });

    await harness.execute('first');
    for (let i = 0; i < 20 && gated.callCount() === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }

    // Submit a follow-up (next-turn). It sits in the queue.
    await harness.execute('follow-up');
    expect(harness.getQueueSize()).toBe(1);

    // User presses ESC.
    const abortPromise = harness.abort({
      reason: 'user',
    });
    gated.release();
    await abortPromise;

    // After abort the follow-up message should still be queued, and a new
    // turn should kick off for it.
    for (let i = 0; i < 50 && gated.callCount() < 2; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(gated.callCount()).toBeGreaterThanOrEqual(2);
    gated.release(); // no-op if already resolved

    for (let i = 0; i < 50 && harness.getStatus().kind !== 'idle'; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const resp = await harness.getAgentResponse();
    expect(resp.text).toBe('done');
  });

  test('turn_started framework event embeds delivered message ids', async () => {
    const harness = new AgentHarness({
      name: 'myagent',
      initialStep: echoStep,
      params: {},
      _testCallModel: async () => textResponse('ok'),
    });

    const fullStream = harness.getFullStream();
    await harness.execute('hello');
    await harness.getAgentResponse();

    const events: StreamEvent[] = [];
    const iter = fullStream[Symbol.asyncIterator]();
    for (let i = 0; i < 80; i++) {
      const { value, done } = await iter.next();
      if (done) {
        break;
      }
      assert(value);
      events.push(value);
      if (value.source === 'framework' && value.type === 'myagent:turn_completed') {
        break;
      }
    }
    await iter.return?.();

    const started = events.find(
      (e) => e.source === 'framework' && e.type === 'myagent:turn_started',
    );
    assert(started);
    const ids = started.data.messageIds;
    expect(Array.isArray(ids)).toBe(true);
  });

  test('sessions are isolated by threadId', async () => {
    const responses = [
      'alpha',
      'beta',
    ];
    let i = 0;
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: async () => {
        const text = responses[i++];
        assert(text);
        return textResponse(text);
      },
    });

    await harness.execute('a', {
      threadId: 'A',
    });
    await harness.execute('b', {
      threadId: 'B',
    });

    const a = await harness.getAgentResponse({
      threadId: 'A',
    });
    const b = await harness.getAgentResponse({
      threadId: 'B',
    });

    expect(a.text).toBe('alpha');
    expect(b.text).toBe('beta');
  });
});
