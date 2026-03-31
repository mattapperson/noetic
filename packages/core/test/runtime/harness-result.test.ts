import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { isNoeticConfigError } from '../../src/errors/noetic-config-error';
import { AgentHarness } from '../../src/runtime/agent-harness';
import { EventBroadcaster } from '../../src/runtime/event-broadcaster';
import { HarnessResultImpl } from '../../src/runtime/harness-result';
import type { StreamEvent } from '../../src/types/harness-result';
import type { ContextMemory } from '../../src/types/memory';
import type { Step } from '../../src/types/step';
import { createScriptedCallModel, makeMockContext, textOnlyResponse } from '../_helpers';

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

/** Emit events to a broadcaster asynchronously to allow consumer iteration. */
function emitAsync(bc: EventBroadcaster, events: StreamEvent[]): void {
  queueMicrotask(() => {
    for (const event of events) {
      bc.emit(event);
    }
    bc.complete();
  });
}

//#endregion

describe('HarnessResult', () => {
  it('getText() returns the final text output', async () => {
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('hello world'),
      ]),
    });

    const result = harness.execute('hi');
    const text = await result.getText();
    expect(text).toBe('hello world');
  });

  it('getResponse() returns items, usage, and text', async () => {
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('response text'),
      ]),
    });

    const result = harness.execute('hi');
    const response = await result.getResponse();
    expect(response.text).toBe('response text');
    expect(response.items.length).toBeGreaterThan(0);
    expect(response.usage.inputTokens).toBeGreaterThanOrEqual(0);
    expect(response.usage.outputTokens).toBeGreaterThanOrEqual(0);
  });

  it('getFullStream() yields framework events for step lifecycle', async () => {
    const harness = new AgentHarness({
      name: 'myagent',
      initialStep: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('streamed'),
      ]),
    });

    const result = harness.execute('hi');
    const events = await collect(result.getFullStream());

    const frameworkEvents = events.filter((e) => e.source === 'framework');
    const started = frameworkEvents.find((e) => e.type === 'myagent:step_started');
    const completed = frameworkEvents.find((e) => e.type === 'myagent:step_completed');

    assert(started, 'should have step_started event');
    assert(completed, 'should have step_completed event');
    expect(started.data.stepId).toBe('echo');
    expect(started.data.kind).toBe('llm');
  });

  it('error case: getText() rejects when no step configured', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });

    const result = harness.execute('hello');

    try {
      await result.getText();
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('NO_STEP_CONFIGURED');
    }
  });

  it('error case: getResponse() rejects when no step configured', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });

    const result = harness.execute('hello');

    try {
      await result.getResponse();
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      assert(isNoeticConfigError(e));
      expect(e.code).toBe('NO_STEP_CONFIGURED');
    }
  });

  it('error case: stream accessors reject when no step configured', async () => {
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });

    const result = harness.execute('hello');

    try {
      await collect(result.getTextStream());
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      assert(isNoeticConfigError(e));
    }

    try {
      await collect(result.getFullStream());
      expect.unreachable('should have thrown');
    } catch (e2: unknown) {
      assert(isNoeticConfigError(e2));
    }
  });

  it('multiple accessors can be consumed from the same result', async () => {
    const harness = new AgentHarness({
      name: 'test',
      initialStep: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('multi'),
      ]),
    });

    const result = harness.execute('hi');
    const [text, response] = await Promise.all([
      result.getText(),
      result.getResponse(),
    ]);

    expect(text).toBe('multi');
    expect(response.text).toBe('multi');
  });
});

describe('HarnessResult — getTextStream', () => {
  it('yields incremental text deltas from SDK events', async () => {
    const bc = new EventBroadcaster();
    const ctx = makeMockContext();
    const executionPromise = Promise.resolve('Hello world');

    const harnessResult = new HarnessResultImpl(bc, executionPromise, ctx);

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

    const deltas = await collect(harnessResult.getTextStream());
    expect(deltas).toEqual([
      'Hello',
      ' ',
      'world',
    ]);
  });
});

describe('HarnessResult — getReasoningStream', () => {
  it('yields reasoning deltas from SDK events', async () => {
    const bc = new EventBroadcaster();
    const ctx = makeMockContext();
    const executionPromise = Promise.resolve('result');

    const harnessResult = new HarnessResultImpl(bc, executionPromise, ctx);

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

    const deltas = await collect(harnessResult.getReasoningStream());
    expect(deltas).toEqual([
      'Let me think',
      ' about this',
    ]);
  });

  it('filters reasoning deltas when interleaved with text deltas', async () => {
    const bc = new EventBroadcaster();
    const ctx = makeMockContext();
    const executionPromise = Promise.resolve('result');

    const harnessResult = new HarnessResultImpl(bc, executionPromise, ctx);

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
      collect(harnessResult.getTextStream()),
      collect(harnessResult.getReasoningStream()),
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

describe('HarnessResult — getItemStream', () => {
  it('yields progressive message snapshots with isComplete transition', async () => {
    const bc = new EventBroadcaster();
    const ctx = makeMockContext();
    const executionPromise = Promise.resolve('hello');

    const harnessResult = new HarnessResultImpl(bc, executionPromise, ctx);

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

    const items = await collect(harnessResult.getItemStream());
    expect(items.length).toBeGreaterThanOrEqual(3);

    // First snapshot: initial item added
    expect(items[0].type).toBe('message');
    expect(items[0].isComplete).toBe(false);

    // Last snapshot: completed
    const last = items[items.length - 1];
    expect(last.isComplete).toBe(true);
    expect(last.status).toBe('completed');
  });

  it('handles multi-round tool calls without accumulator collision', async () => {
    const bc = new EventBroadcaster();
    const ctx = makeMockContext();
    const executionPromise = Promise.resolve('final answer');

    const harnessResult = new HarnessResultImpl(bc, executionPromise, ctx);

    emitAsync(bc, [
      // Round 1: function call at outputIndex 0
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

      // Round 2: message at outputIndex 0 (same index, different round)
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

    const items = await collect(harnessResult.getItemStream());

    // Should have items from both rounds — the function_call and the message
    const functionCalls = items.filter((i) => i.type === 'function_call');
    const messages = items.filter((i) => i.type === 'message');

    expect(functionCalls.length).toBeGreaterThan(0);
    expect(messages.length).toBeGreaterThan(0);

    // Verify the last function call and last message are both completed
    const lastFc = functionCalls[functionCalls.length - 1];
    const lastMsg = messages[messages.length - 1];
    expect(lastFc.isComplete).toBe(true);
    expect(lastMsg.isComplete).toBe(true);
  });

  it('replays events for late subscriber via broadcaster replay', async () => {
    const bc = new EventBroadcaster();
    const ctx = makeMockContext();
    const executionPromise = Promise.resolve('hello');
    const harnessResult = new HarnessResultImpl(bc, executionPromise, ctx);

    // Emit ALL events before subscribing to getItemStream
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

    // Subscribe AFTER all events — should replay from buffer
    const items = await collect(harnessResult.getItemStream());

    expect(items.length).toBeGreaterThanOrEqual(2);
    const last = items[items.length - 1];
    expect(last.isComplete).toBe(true);
    expect(last.type).toBe('message');
  });
});

describe('HarnessResult — error propagation', () => {
  it('getTextStream throws when broadcaster errors', async () => {
    const bc = new EventBroadcaster();
    const ctx = makeMockContext();
    const executionPromise = Promise.reject(new Error('execution failed'));

    // Prevent unhandled rejection
    executionPromise.catch(() => {});

    const harnessResult = new HarnessResultImpl(bc, executionPromise, ctx);

    queueMicrotask(() => {
      bc.emit(
        sdkEvent(
          'response.output_text.delta',
          {
            delta: 'partial',
          },
          0,
        ),
      );
      bc.error(new Error('execution failed'));
    });

    try {
      await collect(harnessResult.getTextStream());
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      if (e instanceof Error) {
        expect(e.message).toBe('execution failed');
      }
    }
  });

  it('getFullStream throws when broadcaster errors', async () => {
    const bc = new EventBroadcaster();
    const ctx = makeMockContext();
    const executionPromise = Promise.reject(new Error('boom'));
    executionPromise.catch(() => {});

    const harnessResult = new HarnessResultImpl(bc, executionPromise, ctx);

    queueMicrotask(() => {
      bc.error(new Error('boom'));
    });

    try {
      await collect(harnessResult.getFullStream());
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      if (e instanceof Error) {
        expect(e.message).toBe('boom');
      }
    }
  });

  it('getText rejects when execution promise rejects', async () => {
    const bc = new EventBroadcaster();
    const ctx = makeMockContext();
    const executionPromise = Promise.reject(new Error('step failed'));
    executionPromise.catch(() => {});

    const harnessResult = new HarnessResultImpl(bc, executionPromise, ctx);

    try {
      await harnessResult.getText();
      expect.unreachable('should have thrown');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      if (e instanceof Error) {
        expect(e.message).toBe('step failed');
      }
    }
  });
});

describe('HarnessResult — emit option', () => {
  it('emit: false suppresses all framework events', async () => {
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

    const result = harness.execute('hi');
    const events = await collect(result.getFullStream());

    const frameworkEvents = events.filter((e) => e.source === 'framework');
    expect(frameworkEvents).toHaveLength(0);
  });

  it('emit filter function selectively suppresses events', async () => {
    const filteredStep: Step<ContextMemory, string, string> = {
      kind: 'llm',
      id: 'filtered',
      model: 'test/echo',
      tools: [],
      emit: (eventType) => eventType === 'step_started',
    };

    const harness = new AgentHarness({
      name: 'myagent',
      initialStep: filteredStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('filtered'),
      ]),
    });

    const result = harness.execute('hi');
    const events = await collect(result.getFullStream());

    const frameworkEvents = events.filter((e) => e.source === 'framework');
    const started = frameworkEvents.filter((e) => e.type === 'myagent:step_started');
    const completed = frameworkEvents.filter((e) => e.type === 'myagent:step_completed');

    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(0);
  });
});
