import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { z } from 'zod';
import { tool } from '../../src/builders/tool-builder';
import { isNoeticConfigError } from '../../src/errors/noetic-config-error';
import { frameworkCast } from '../../src/interpreter/framework-cast';
import { AgentHarness } from '../../src/runtime/agent-harness';
import { EventBroadcaster } from '../../src/runtime/event-broadcaster';
import {
  buildItemStream,
  filterReasoningStream,
  filterTextStream,
} from '../../src/runtime/session-streams';
import type { LLMResponse } from '../../src/types/common';
import type { StreamEvent } from '../../src/types/harness-result';
import type { ContextMemory } from '../../src/types/memory';
import type { Step } from '../../src/types/step';
import { createScriptedCallModel, makeMessage, textOnlyResponse } from '../_helpers';

//#region Helpers

const echoStep: Step<ContextMemory, string, string> = {
  kind: 'llm',
  id: 'echo',
  model: 'test/echo',
  tools: [],
};

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iter) {
    items.push(item);
  }
  return items;
}

function sdkEvent(type: string, data: Record<string, unknown>, outputIndex?: number): StreamEvent {
  return {
    source: 'sdk',
    type,
    data,
    outputIndex,
  };
}

function emitAsync(bc: EventBroadcaster, events: StreamEvent[]): void {
  queueMicrotask(() => {
    for (const event of events) {
      bc.emit(event);
    }
    bc.complete();
  });
}

type MockModelResponse = LLMResponse & {
  id: string;
  output: LLMResponse['items'];
  outputText?: string;
  status?: string;
  incompleteDetails?: Record<string, unknown>;
};

type RecordedModelInput = Array<Record<string, unknown>>;

function isEphemeralContinueInput(input: RecordedModelInput): boolean {
  const last = input[input.length - 1];
  return last?.role === 'user' && last.content === 'continue';
}

function hasEphemeralContinueInput(input: RecordedModelInput): boolean {
  return input.some((item) => item.role === 'user' && item.content === 'continue');
}

function messageResponse(id: string, text: string): MockModelResponse {
  return frameworkCast<MockModelResponse>({
    id,
    status: 'completed',
    output: [
      {
        id: `msg-${id}`,
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
  });
}

function functionCallResponse(callNumber: number): MockModelResponse {
  const callId = `call_${callNumber}`;
  return frameworkCast<MockModelResponse>({
    id: `resp-${callNumber}`,
    status: 'completed',
    output: [
      {
        id: `fc-${callNumber}`,
        status: 'completed',
        type: 'function_call',
        callId,
        name: 'noop',
        arguments: '{}',
      },
    ],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
    },
  });
}

class ToolLimitRecoveryClient {
  calls = 0;
  readonly inputs: RecordedModelInput[] = [];

  callModel(request: { input: RecordedModelInput }): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<MockModelResponse>;
  } {
    const callNumber = this.calls++;
    this.inputs.push(request.input);
    return {
      async *getFullResponsesStream() {},
      getResponse: async () => {
        if (callNumber >= 32 && isEphemeralContinueInput(request.input)) {
          return messageResponse(`resp-final-${callNumber}`, 'finished after continue');
        }
        return functionCallResponse(callNumber);
      },
    };
  }
}

class InvalidStateRecoveryClient {
  calls = 0;
  readonly inputs: RecordedModelInput[] = [];

  constructor(private readonly firstResponse: MockModelResponse) {}

  callModel(request: { input: RecordedModelInput }): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<MockModelResponse>;
  } {
    const callNumber = this.calls++;
    this.inputs.push(request.input);
    return {
      async *getFullResponsesStream() {},
      getResponse: async () => {
        if (callNumber === 0) {
          return this.firstResponse;
        }
        if (callNumber === 1 && isEphemeralContinueInput(request.input)) {
          return functionCallResponse(callNumber);
        }
        return messageResponse(`resp-final-${callNumber}`, 'recovered');
      },
    };
  }
}

//#endregion

describe('AgentHarness session accessors', () => {
  it('getAgentResponse() returns items, usage, and text', async () => {
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('response text'),
      ]),
    });

    await harness.execute('hi');
    const response = await harness.getAgentResponse();
    expect(response.text).toBe('response text');
    expect(response.items.length).toBeGreaterThan(0);
    expect(response.usage.inputTokens).toBe(10);
    expect(response.usage.outputTokens).toBe(5);
  });

  it('getFullStream() yields framework events for step and turn lifecycle', async () => {
    const harness = new AgentHarness({
      name: 'myagent',
      initialStep: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('streamed'),
      ]),
    });

    // Start consumer before execute so we don't miss replay.
    const fullStream = harness.getFullStream();
    await harness.execute('hi');
    await harness.getAgentResponse();

    // Drain whatever events have accumulated so far.
    const events: StreamEvent[] = [];
    const iter = fullStream[Symbol.asyncIterator]();
    // Pull until we've seen turn_completed, then stop.
    for (let i = 0; i < 200; i++) {
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

    const frameworkEvents = events.filter((e) => e.source === 'framework');
    const turnStarted = frameworkEvents.find((e) => e.type === 'myagent:turn_started');
    const turnCompleted = frameworkEvents.find((e) => e.type === 'myagent:turn_completed');
    const stepStarted = frameworkEvents.find((e) => e.type === 'myagent:step_started');

    assert(turnStarted, 'should emit turn_started');
    assert(turnCompleted, 'should emit turn_completed');
    assert(stepStarted, 'should emit step_started');
    expect(stepStarted.data.stepId).toBe('echo');
  });

  it('rejects execute() with NoeticConfigError when no step is configured', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });

    try {
      await harness.execute('hello');
      expect.unreachable('should have rejected');
    } catch (e: unknown) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('NO_STEP_CONFIGURED');
    }
  });

  it('multiple stream accessors share the same session broadcaster', async () => {
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('multi'),
      ]),
    });

    await harness.execute('hi');
    const response = await harness.getAgentResponse();
    expect(response.text).toBe('multi');
  });

  it('recovers from the tool-round limit with an ephemeral continue retry', async () => {
    const fakeClient = new ToolLimitRecoveryClient();
    const noopTool = tool({
      name: 'noop',
      description: 'Always returns ok',
      input: z.object({}),
      output: z.object({
        ok: z.boolean(),
      }),
      execute: async () => ({
        ok: true,
      }),
    });
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    frameworkCast<{
      client: ToolLimitRecoveryClient;
    }>(harness).client = fakeClient;
    const ctx = harness.createContext();

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'keep using tools'),
      ],
      tools: [
        noopTool,
      ],
      ctx,
    });

    expect(fakeClient.calls).toBe(33);
    expect(fakeClient.inputs.slice(0, 32).some(hasEphemeralContinueInput)).toBe(false);
    expect(hasEphemeralContinueInput(fakeClient.inputs[32] ?? [])).toBe(true);
    expect(ctx.itemLog.items.some((item) => item.type === 'message' && item.role === 'user')).toBe(
      false,
    );
    expect(response.items.at(-1)).toMatchObject({
      type: 'message',
      role: 'assistant',
    });
  });

  it('recovers incomplete provider responses without persisting the synthetic continue', async () => {
    const noopTool = tool({
      name: 'noop',
      description: 'Always returns ok',
      input: z.object({}),
      output: z.object({
        ok: z.boolean(),
      }),
      execute: async () => ({
        ok: true,
      }),
    });
    const fakeClient = new InvalidStateRecoveryClient(
      frameworkCast<MockModelResponse>({
        id: 'resp-incomplete',
        status: 'incomplete',
        incompleteDetails: {
          reason: 'max_output_tokens',
        },
        output: [],
        usage: {
          inputTokens: 1,
          outputTokens: 0,
        },
      }),
    );
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    frameworkCast<{
      client: InvalidStateRecoveryClient;
    }>(harness).client = fakeClient;
    const ctx = harness.createContext();

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'start'),
      ],
      tools: [
        noopTool,
      ],
      ctx,
    });

    expect(fakeClient.calls).toBe(3);
    expect(hasEphemeralContinueInput(fakeClient.inputs[0] ?? [])).toBe(false);
    expect(isEphemeralContinueInput(fakeClient.inputs[1] ?? [])).toBe(true);
    expect(hasEphemeralContinueInput(fakeClient.inputs[2] ?? [])).toBe(false);
    expect(ctx.itemLog.items.some((item) => item.type === 'message' && item.role === 'user')).toBe(
      false,
    );
    expect(response.items.at(-1)).toMatchObject({
      type: 'message',
      role: 'assistant',
    });
  });

  it('recovers empty successful provider responses with an ephemeral continue retry', async () => {
    const fakeClient = new InvalidStateRecoveryClient(
      frameworkCast<MockModelResponse>({
        id: 'resp-empty',
        status: 'completed',
        output: [],
        usage: {
          inputTokens: 1,
          outputTokens: 0,
        },
      }),
    );
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    frameworkCast<{
      client: InvalidStateRecoveryClient;
    }>(harness).client = fakeClient;

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'start'),
      ],
    });

    expect(fakeClient.calls).toBe(2);
    expect(hasEphemeralContinueInput(fakeClient.inputs[0] ?? [])).toBe(false);
    expect(isEphemeralContinueInput(fakeClient.inputs[1] ?? [])).toBe(true);
    expect(response.items.at(-1)).toMatchObject({
      type: 'function_call',
      name: 'noop',
    });
  });
});

describe('session-streams — filterTextStream', () => {
  it('yields incremental text deltas from SDK events', async () => {
    const bc = new EventBroadcaster();

    emitAsync(bc, [
      sdkEvent(
        'response.output_text.delta',
        {
          delta: 'Hello',
        },
        0,
      ),
      sdkEvent(
        'response.output_text.delta',
        {
          delta: ' ',
        },
        0,
      ),
      sdkEvent(
        'response.output_text.delta',
        {
          delta: 'world',
        },
        0,
      ),
    ]);

    const deltas = await collect(filterTextStream(bc));
    expect(deltas).toEqual([
      'Hello',
      ' ',
      'world',
    ]);
  });
});

describe('session-streams — filterReasoningStream', () => {
  it('yields reasoning deltas from SDK events', async () => {
    const bc = new EventBroadcaster();

    emitAsync(bc, [
      sdkEvent(
        'response.reasoning.delta',
        {
          delta: 'Let me think',
        },
        0,
      ),
      sdkEvent(
        'response.reasoning.delta',
        {
          delta: ' about this',
        },
        0,
      ),
    ]);

    const deltas = await collect(filterReasoningStream(bc));
    expect(deltas).toEqual([
      'Let me think',
      ' about this',
    ]);
  });

  it('filters reasoning deltas when interleaved with text deltas', async () => {
    const bc = new EventBroadcaster();

    emitAsync(bc, [
      sdkEvent(
        'response.output_text.delta',
        {
          delta: 'Hello',
        },
        0,
      ),
      sdkEvent(
        'response.reasoning.delta',
        {
          delta: 'Think step 1',
        },
        0,
      ),
      sdkEvent(
        'response.output_text.delta',
        {
          delta: ' world',
        },
        0,
      ),
      sdkEvent(
        'response.reasoning.delta',
        {
          delta: ' and step 2',
        },
        0,
      ),
      sdkEvent('response.output_text.done', {}, 0),
    ]);

    const [textDeltas, reasoningDeltas] = await Promise.all([
      collect(filterTextStream(bc)),
      collect(filterReasoningStream(bc)),
    ]);

    expect(textDeltas).toEqual([
      'Hello',
      ' world',
    ]);
    expect(reasoningDeltas).toEqual([
      'Think step 1',
      ' and step 2',
    ]);
  });
});

describe('session-streams — buildItemStream', () => {
  it('yields progressive message snapshots with isComplete transition', async () => {
    const bc = new EventBroadcaster();

    emitAsync(bc, [
      sdkEvent('response.created', {}, undefined),
      sdkEvent(
        'response.output_item.added',
        {
          item: {
            type: 'message',
            id: 'msg-1',
          },
        },
        0,
      ),
      sdkEvent(
        'response.output_text.delta',
        {
          delta: 'hel',
        },
        0,
      ),
      sdkEvent(
        'response.output_text.delta',
        {
          delta: 'lo',
        },
        0,
      ),
      sdkEvent('response.output_text.done', {}, 0),
      sdkEvent('response.output_item.done', {}, 0),
    ]);

    const items = await collect(buildItemStream(bc));
    expect(items.length).toBeGreaterThanOrEqual(3);

    expect(items[0]?.type).toBe('message');
    expect(items[0]?.isComplete).toBe(false);

    const last = items[items.length - 1];
    assert(last);
    expect(last.isComplete).toBe(true);
    assert(last.type === 'message');
    expect(last.status).toBe('completed');
  });

  it('handles multi-round tool calls without accumulator collision', async () => {
    const bc = new EventBroadcaster();

    emitAsync(bc, [
      sdkEvent('response.created', {}, undefined),
      sdkEvent(
        'response.output_item.added',
        {
          item: {
            type: 'function_call',
            id: 'fc-1',
            callId: 'call-1',
            name: 'search',
          },
        },
        0,
      ),
      sdkEvent(
        'response.function_call_arguments.delta',
        {
          delta: '{"q":"test"}',
        },
        0,
      ),
      sdkEvent('response.function_call_arguments.done', {}, 0),
      sdkEvent('response.output_item.done', {}, 0),

      sdkEvent('response.created', {}, undefined),
      sdkEvent(
        'response.output_item.added',
        {
          item: {
            type: 'message',
            id: 'msg-1',
          },
        },
        0,
      ),
      sdkEvent(
        'response.output_text.delta',
        {
          delta: 'final answer',
        },
        0,
      ),
      sdkEvent('response.output_text.done', {}, 0),
      sdkEvent('response.output_item.done', {}, 0),
    ]);

    const items = await collect(buildItemStream(bc));

    const functionCalls = items.filter((i) => i.type === 'function_call');
    const messages = items.filter((i) => i.type === 'message');

    expect(functionCalls.length).toBeGreaterThan(0);
    expect(messages.length).toBeGreaterThan(0);

    const lastFc = functionCalls[functionCalls.length - 1];
    const lastMsg = messages[messages.length - 1];
    assert(lastFc);
    assert(lastMsg);
    expect(lastFc.isComplete).toBe(true);
    expect(lastMsg.isComplete).toBe(true);
  });

  it('replays events for late subscriber via broadcaster replay', async () => {
    const bc = new EventBroadcaster();

    bc.emit(sdkEvent('response.created', {}, undefined));
    bc.emit(
      sdkEvent(
        'response.output_item.added',
        {
          item: {
            type: 'message',
            id: 'msg-1',
          },
        },
        0,
      ),
    );
    bc.emit(
      sdkEvent(
        'response.output_text.delta',
        {
          delta: 'hello',
        },
        0,
      ),
    );
    bc.emit(sdkEvent('response.output_text.done', {}, 0));
    bc.emit(sdkEvent('response.output_item.done', {}, 0));
    bc.complete();

    const items = await collect(buildItemStream(bc));

    expect(items.length).toBeGreaterThanOrEqual(2);
    const last = items[items.length - 1];
    assert(last);
    expect(last.isComplete).toBe(true);
    expect(last.type).toBe('message');
  });
});

describe('AgentHarness — emit option', () => {
  it('emit: false suppresses framework events inside callModel', async () => {
    const silentStep: Step<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'silent',
      model: 'test/echo',
      tools: [],
      emit: false,
    };

    const harness = new AgentHarness({
      name: 'myagent',
      initialStep: silentStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('quiet'),
      ]),
    });

    // Start broadcast consumer BEFORE execute.
    const fullStream = harness.getFullStream();
    await harness.execute('hi');
    await harness.getAgentResponse();

    // Drain until turn_completed.
    const events: StreamEvent[] = [];
    const iter = fullStream[Symbol.asyncIterator]();
    for (let i = 0; i < 100; i++) {
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

    // Step-level emit: false suppresses step events, but turn_started/turn_completed
    // are emitted by the runner (not gated by step.emit).
    const stepEvents = events.filter((e) => e.source === 'framework' && e.type.includes(':step_'));
    expect(stepEvents).toHaveLength(0);
  });
});
