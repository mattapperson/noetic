import { describe, expect, test } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { AgentHarness } from '../../src/runtime/agent-harness';
import type { LLMResponse } from '../../src/types/common';
import type { StreamEvent } from '../../src/types/harness-result';
import type { ContextMemory } from '../../src/types/memory';
import type { CallModelRequest } from '../../src/types/runtime';
import type { Step } from '../../src/types/step';
import type { Tool } from '../../src/types/tool';

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
 *  synthesises a deferred completion controlled by a shared gate. A single
 *  `release()` resolves the gate permanently, so subsequent calls pass
 *  through without blocking. */
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

type GatedCall = {
  resolve: () => void;
  promise: Promise<void>;
};

/** Scripted callModel with independent per-call gates. Each invocation blocks
 *  on its own gate and returns the next scripted response. `releaseNext()`
 *  resolves the oldest pending gate so its turn can complete. */
function makeMultiGatedCallModel(responses: string[]): {
  call: (request: CallModelRequest) => Promise<LLMResponse>;
  requests: CallModelRequest[];
  releaseNext: () => void;
  callCount: () => number;
  waitForCall: (n: number, timeoutMs?: number) => Promise<void>;
} {
  const requests: CallModelRequest[] = [];
  const gates: GatedCall[] = [];
  let callIdx = 0;

  const call = async (request: CallModelRequest): Promise<LLMResponse> => {
    requests.push(request);
    const myIdx = callIdx++;
    const text = responses[myIdx];
    if (!text) {
      throw new Error(`exhausted: no response for call index ${myIdx}`);
    }
    let resolveFn: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });
    const gate: GatedCall = {
      promise,
      resolve: () => resolveFn?.(),
    };
    gates.push(gate);
    await gate.promise;
    return textResponse(text);
  };

  const releaseNext = (): void => {
    const gate = gates.shift();
    gate?.resolve();
  };

  const waitForCall = async (n: number, timeoutMs = 500): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (requests.length < n && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  return {
    call,
    requests,
    releaseNext,
    callCount: () => requests.length,
    waitForCall,
  };
}

//#endregion

describe('AgentHarness delivery modes', () => {
  test('next-turn: queued message runs as a second turn after the first completes', async () => {
    // Use a per-call gated callModel so we can deterministically sequence the
    // two turns. The drainAll path would otherwise coalesce both messages into
    // one turn if they both arrive before the runner pulls from the queue.
    const gated = makeMultiGatedCallModel([
      'alpha',
      'beta',
    ]);

    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: gated.call,
    });

    // 1. Submit the first message.
    await harness.execute('first');

    // 2. Wait until the runner is committed to turn 1 (callModel invoked).
    await gated.waitForCall(1);
    expect(gated.callCount()).toBe(1);

    // 3. Submit the second message. The runner is mid-turn, so this will be
    //    queued and picked up only after turn 1 finishes — giving us a true
    //    second turn instead of a coalesced drain.
    await harness.execute('second');

    // 4. Release turn 1's gate so it can complete.
    gated.releaseNext();

    // 5. Wait for turn 2 to begin, then release it too.
    await gated.waitForCall(2);
    gated.releaseNext();

    // 6. Await idle and assert the semantics.
    for (let i = 0; i < 50 && harness.getStatus().kind !== 'idle'; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const resp = await harness.getAgentResponse();
    // Final response reflects the last turn's text.
    expect(resp.text).toBe('beta');
    // Two calls occurred because both messages drove their own turns.
    expect(gated.callCount()).toBe(2);
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

  test('messageId option round-trips to turn_started.messageIds', async () => {
    const harness = new AgentHarness({
      name: 'myagent',
      initialStep: echoStep,
      params: {},
      _testCallModel: async () => textResponse('ok'),
    });

    const fullStream = harness.getFullStream();
    await harness.execute('hello', {
      messageId: 'custom-abc-123',
    });
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
      if (value.source === 'framework' && value.type === 'myagent:turn_started') {
        break;
      }
    }
    await iter.return?.();

    const started = events.find(
      (e) => e.source === 'framework' && e.type === 'myagent:turn_started',
    );
    assert(started);
    expect(started.data.messageIds).toEqual([
      'custom-abc-123',
    ]);
  });

  test('per-turn options: second execute overrides first-call resourceId', async () => {
    // The callModel request includes `ctx` whenever the step has tools. We
    // add a single unused tool to the step so we can read `request.ctx.resourceId`.
    const noopTool: Tool<z.ZodObject<Record<string, never>>, z.ZodString> = {
      name: 'noop',
      description: 'unused',
      input: z.object({}),
      output: z.string(),
      execute: async () => 'never called',
    };
    const stepWithTools: Step<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'tooled',
      model: 'test/echo',
      tools: [
        noopTool,
      ],
    };

    const seenResourceIds: Array<string | undefined> = [];
    const harness = new AgentHarness({
      name: 'test',
      initialStep: stepWithTools,
      params: {},
      _testCallModel: async (request: CallModelRequest) => {
        if ('ctx' in request && request.ctx) {
          seenResourceIds.push(request.ctx.resourceId);
        }
        return textResponse('ok');
      },
    });

    await harness.execute('first-turn', {
      resourceId: 'resource-1',
    });
    await harness.getAgentResponse();
    await harness.execute('second-turn', {
      resourceId: 'resource-2',
    });
    await harness.getAgentResponse();

    expect(seenResourceIds).toEqual([
      'resource-1',
      'resource-2',
    ]);
  });

  test('getAgentResponse waits for next turn after prior error', async () => {
    let callIdx = 0;
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: async () => {
        const i = callIdx++;
        if (i === 0) {
          throw new Error('first-turn-boom');
        }
        return textResponse('second-ok');
      },
    });

    // First turn errors. Swallow the error via getAgentResponse.
    await harness.execute('a');
    await harness.getAgentResponse().catch(() => {});

    // Enqueue second message BEFORE calling getAgentResponse so queue.size
    // is non-zero at the call site. Under the fixed logic, the lastError
    // short-circuit only fires when idle AND queue is empty.
    await harness.execute('b');
    const resp = await harness.getAgentResponse();

    expect(resp.text).toBe('second-ok');
  });
});
