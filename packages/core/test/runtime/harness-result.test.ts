import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type { Item, LLMResponse, Step, StreamEvent, StreamingItem } from '@noetic-tools/types';
import {
  frameworkCast,
  ItemSchemaRegistry,
  isNoeticConfigError,
  isNoeticError,
} from '@noetic-tools/types';
import { z } from 'zod';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { EventBroadcaster } from '../../src/runtime/event-broadcaster';
import {
  buildItemStream,
  filterReasoningStream,
  filterTextStream,
} from '../../src/runtime/session-streams';
import {
  createScriptedCallModel,
  makeLLMResponse,
  makeMessage,
  textOnlyResponse,
} from '../_helpers';

//#region Helpers

const echoStep: Step<ContextData, string, string> = {
  kind: 'callModel',
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
        // Varied per round: this fixture exercises the tool-round LIMIT path;
        // identical arguments would (correctly) trip the doom-loop guard first.
        arguments: `{"step":${callNumber}}`,
      },
    ],
    usage: {
      inputTokens: 1,
      outputTokens: 1,
    },
  });
}

interface PollingClientConfig {
  toolName: string;
  /** Sent verbatim on every round — a poll's request side never varies. */
  toolArgs: string;
  /** Round index at which the model stops polling and answers. */
  stopAfterRounds: number;
}

/**
 * A model that polls one tool with BYTE-IDENTICAL arguments every round until
 * the tool reports ready, then answers. This is the exact shape of a legitimate
 * wait/poll loop: the request side cannot vary, only the result can.
 */
class PollingClient {
  calls = 0;
  private readonly config: PollingClientConfig;

  constructor(config: PollingClientConfig) {
    this.config = config;
  }

  callModel(): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<MockModelResponse>;
  } {
    const callNumber = this.calls++;
    const { toolName, toolArgs, stopAfterRounds } = this.config;
    return {
      async *getFullResponsesStream() {},
      getResponse: async () => {
        if (callNumber >= stopAfterRounds) {
          return messageResponse(`resp-final-${callNumber}`, 'build is ready');
        }
        return frameworkCast<MockModelResponse>({
          id: `resp-${callNumber}`,
          status: 'completed',
          output: [
            {
              id: `fc-${callNumber}`,
              status: 'completed',
              type: 'function_call',
              callId: `call_${callNumber}`,
              name: toolName,
              arguments: toolArgs,
            },
          ],
          usage: {
            inputTokens: 1,
            outputTokens: 1,
          },
        });
      },
    };
  }
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

class DecoratingToolClient {
  calls = 0;

  constructor(
    private readonly toolName: string = 'count',
    private readonly toolArguments: string = '{"count":3}',
  ) {}

  callModel(): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<MockModelResponse>;
  } {
    return {
      async *getFullResponsesStream() {},
      getResponse: async () => {
        this.calls += 1;
        return this.calls === 1
          ? frameworkCast<MockModelResponse>({
              id: `resp-${this.toolName}-call`,
              status: 'completed',
              output: [
                {
                  id: `fc-${this.toolName}`,
                  status: 'completed',
                  type: 'function_call',
                  callId: `call-${this.toolName}`,
                  name: this.toolName,
                  arguments: this.toolArguments,
                },
              ],
              usage: {
                inputTokens: 1,
                outputTokens: 1,
              },
            })
          : messageResponse(`${this.toolName}-final`, 'done');
      },
    };
  }
}

//#endregion

describe('AgentHarness session accessors', () => {
  it('getAgentResponse() returns items, usage, and text', async () => {
    const harness = new AgentHarness({
      name: 'test',
      agentGraph: echoStep,
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

  it('getUsage() returns zeros for a session that has not run', () => {
    const harness = new AgentHarness({
      name: 'test',
      agentGraph: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('unused'),
      ]),
    });
    expect(harness.getUsage()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(
      harness.getUsage({
        threadId: 'never-ran',
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('getUsage() accumulates token usage across turns on the same session', async () => {
    const harness = new AgentHarness({
      name: 'test',
      agentGraph: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('first'),
        textOnlyResponse('second'),
      ]),
    });

    await harness.execute('one');
    await harness.getAgentResponse();
    const afterFirst = harness.getUsage();
    expect(afterFirst.inputTokens).toBe(10);
    expect(afterFirst.outputTokens).toBe(5);

    await harness.execute('two');
    await harness.getAgentResponse();
    const afterSecond = harness.getUsage();
    expect(afterSecond.inputTokens).toBe(20);
    expect(afterSecond.outputTokens).toBe(10);

    // Sessions are thread-scoped: another thread's accounting stays untouched.
    expect(
      harness.getUsage({
        threadId: 'other-thread',
      }),
    ).toEqual({
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('omits cachedTokens on session and per-turn usage when no cache figure was reported', async () => {
    const harness = new AgentHarness({
      name: 'test',
      agentGraph: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        // `textOnlyResponse` carries no `cachedTokens` — the provider says
        // nothing about caching at all.
        textOnlyResponse('no cache info'),
      ]),
    });

    await harness.execute('hi');
    const response = await harness.getAgentResponse();
    const usage = harness.getUsage();
    expect(usage.inputTokens).toBe(10);
    expect(usage.cachedTokens).toBeUndefined();
    // The per-turn `HarnessResponse.usage` carries the same semantics.
    expect(response.usage.cachedTokens).toBeUndefined();
  });

  it('reports cachedTokens 0 on session and per-turn usage when a turn reported zero', async () => {
    const harness = new AgentHarness({
      name: 'test',
      agentGraph: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        makeLLMResponse('nothing cached', {
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedTokens: 0,
          },
        }),
      ]),
    });

    await harness.execute('hi');
    const response = await harness.getAgentResponse();
    const usage = harness.getUsage();
    // An explicit report of 0 must NOT collapse to undefined — callers need to
    // tell "nothing was cached" from "this provider says nothing about caching".
    expect(usage.cachedTokens).toBe(0);
    // Same pin on the per-turn `HarnessResponse.usage`, which used to collapse
    // a reported 0 to `undefined` via a `> 0` guard in buildResponse.
    expect(response.usage.cachedTokens).toBe(0);
  });

  it('getUsage() accumulates cachedTokens across turns that report them', async () => {
    const harness = new AgentHarness({
      name: 'test',
      agentGraph: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        makeLLMResponse('first', {
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedTokens: 4,
          },
        }),
        makeLLMResponse('second', {
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedTokens: 6,
          },
        }),
      ]),
    });

    await harness.execute('one');
    await harness.getAgentResponse();
    expect(harness.getUsage().cachedTokens).toBe(4);

    await harness.execute('two');
    await harness.getAgentResponse();
    expect(harness.getUsage().cachedTokens).toBe(10);
  });

  it('getUsage() still accounts for a turn that failed after the model billed', async () => {
    // The model call is nested inside a `runCode` graph so the throw happens
    // AFTER usage was tracked — a `_testCallModel` that throws would never
    // accrue anything to accumulate.
    let harnessRef: AgentHarness | undefined;
    const modelThenThrow: Step<ContextData, string, string> = {
      kind: 'runCode',
      id: 'model-then-throw',
      execute: async (input, execCtx) => {
        assert(harnessRef);
        await harnessRef.run(echoStep, input, execCtx);
        throw new Error('boom after the model billed');
      },
    };

    const harness = new AgentHarness({
      name: 'test',
      agentGraph: modelThenThrow,
      params: {},
      _testCallModel: createScriptedCallModel([
        makeLLMResponse('billed', {
          usage: {
            inputTokens: 10,
            outputTokens: 5,
            cachedTokens: 3,
          },
        }),
      ]),
    });
    harnessRef = harness;

    await harness.execute('hi');
    await expect(harness.getAgentResponse()).rejects.toThrow(/boom after the model billed/);

    const usage = harness.getUsage();
    expect(usage.inputTokens).toBe(10);
    expect(usage.outputTokens).toBe(5);
    expect(usage.cachedTokens).toBe(3);
  });

  it('getFullStream() yields framework events for step and turn lifecycle', async () => {
    const harness = new AgentHarness({
      name: 'myagent',
      agentGraph: echoStep,
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
      agentGraph: echoStep,
      params: {},
      _testCallModel: createScriptedCallModel([
        textOnlyResponse('multi'),
      ]),
    });

    await harness.execute('hi');
    const response = await harness.getAgentResponse();
    expect(response.text).toBe('multi');
  });

  it('getItemStream carries framework-authored items: turn inputs and tool results', async () => {
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
    const toolStep: Step<ContextData, string, string> = {
      kind: 'callModel',
      id: 'tooled',
      model: 'test/model',
      tools: [
        noopTool,
      ],
    };
    const harness = new AgentHarness({
      name: 'test',
      agentGraph: toolStep,
      params: {},
    });
    const fakeClient = new DecoratingToolClient('noop', '{}');
    frameworkCast<{
      client: DecoratingToolClient;
    }>(harness).client = fakeClient;

    const collected: StreamingItem[] = [];
    async function pumpItems(): Promise<void> {
      for await (const item of harness.getItemStream()) {
        collected.push(item);
      }
    }
    void pumpItems();

    await harness.execute('use the noop tool');
    await harness.getAgentResponse();
    // Let the broadcaster's queued events flush through the pump.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(collected.some((item) => item.type === 'message' && item.role === 'user')).toBe(true);
    expect(
      collected.some((item) => item.type === 'function_call_output' && item.callId === 'call-noop'),
    ).toBe(true);
  });

  it('throws a structured doom-loop error on repeated identical tool rounds', async () => {
    class StuckClient {
      calls = 0;
      callModel(): {
        getFullResponsesStream: () => AsyncIterable<unknown>;
        getResponse: () => Promise<MockModelResponse>;
      } {
        const callNumber = this.calls++;
        return {
          async *getFullResponsesStream() {},
          getResponse: async () =>
            frameworkCast<MockModelResponse>({
              id: `resp-${callNumber}`,
              status: 'completed',
              output: [
                {
                  id: `fc-${callNumber}`,
                  status: 'completed',
                  type: 'function_call',
                  callId: `call_${callNumber}`,
                  name: 'noop',
                  arguments: '{}', // identical every round — a stuck model
                },
              ],
              usage: {
                inputTokens: 1,
                outputTokens: 1,
              },
            }),
        };
      }
    }
    const fakeClient = new StuckClient();
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
      client: StuckClient;
    }>(harness).client = fakeClient;
    const ctx = harness.createContext();

    await expect(
      harness.callModel({
        model: 'test/model',
        items: [
          makeMessage('user', 'go'),
        ],
        tools: [
          noopTool,
        ],
        ctx,
      }),
    ).rejects.toThrow('Doom loop detected');
    // Guard trips after 4 identical rounds (1 + DOOM_LOOP_IDENTICAL_ROUNDS),
    // not after the 32-round limit.
    expect(fakeClient.calls).toBeLessThan(10);
  });

  it('does not trip the doom-loop guard when only a nested argument value differs', async () => {
    // The fingerprint canonicalizes arguments by sorting keys at EVERY depth. A
    // top-level-only key allowlist would collapse `{"filter":{"page":N}}` to
    // `{"filter":{}}` for all N and abort this healthy run.
    class NestedArgsClient {
      calls = 0;
      callModel(): {
        getFullResponsesStream: () => AsyncIterable<unknown>;
        getResponse: () => Promise<MockModelResponse>;
      } {
        const callNumber = this.calls++;
        return {
          async *getFullResponsesStream() {},
          getResponse: async () => {
            if (callNumber >= 6) {
              return messageResponse(`resp-final-${callNumber}`, 'done');
            }
            return frameworkCast<MockModelResponse>({
              id: `resp-${callNumber}`,
              status: 'completed',
              output: [
                {
                  id: `fc-${callNumber}`,
                  status: 'completed',
                  type: 'function_call',
                  callId: `call_${callNumber}`,
                  name: 'search',
                  arguments: `{"filter":{"page":${callNumber},"kind":"doc"}}`,
                },
              ],
              usage: {
                inputTokens: 1,
                outputTokens: 1,
              },
            });
          },
        };
      }
    }
    const fakeClient = new NestedArgsClient();
    const searchTool = tool({
      name: 'search',
      description: 'Paginated search',
      input: z.object({
        filter: z.object({
          page: z.number(),
          kind: z.string(),
        }),
      }),
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
      client: NestedArgsClient;
    }>(harness).client = fakeClient;
    const ctx = harness.createContext();

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'go'),
      ],
      tools: [
        searchTool,
      ],
      ctx,
    });

    // Six distinct tool rounds ran to completion, then the final message.
    expect(fakeClient.calls).toBe(7);
    expect(
      response.items.some((item) => item.type === 'message' && item.role === 'assistant'),
    ).toBe(true);
  });

  it('does not trip the doom-loop guard on a polling loop whose tool results evolve', async () => {
    // The canonical false positive (finding #15): `check_build` is called with
    // byte-identical arguments on every attempt — that IS what polling looks
    // like — and only the RESULT advances. A request-only fingerprint aborts
    // this run on the 4th poll, two polls before the build is ready.
    const readyOnPoll = 6;
    const fakeClient = new PollingClient({
      toolName: 'check_build',
      toolArgs: '{"id":"build-7"}',
      stopAfterRounds: readyOnPoll,
    });
    let pollsServed = 0;
    const checkBuildTool = tool({
      name: 'check_build',
      description: 'Poll a build until it is ready',
      input: z.object({
        id: z.string(),
      }),
      output: z.object({
        status: z.string(),
        progress: z.number(),
      }),
      execute: async () => {
        pollsServed += 1;
        // Progress advances on every poll, so consecutive rounds are never
        // byte-identical on the result side.
        return pollsServed >= readyOnPoll
          ? {
              status: 'ready',
              progress: 100,
            }
          : {
              status: 'pending',
              progress: pollsServed * 15,
            };
      },
    });
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    frameworkCast<{
      client: PollingClient;
    }>(harness).client = fakeClient;
    const ctx = harness.createContext();

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'wait for build-7'),
      ],
      tools: [
        checkBuildTool,
      ],
      ctx,
    });

    // Survived well past the 4-round threshold and reached the ready state.
    expect(pollsServed).toBe(readyOnPoll);
    expect(fakeClient.calls).toBe(readyOnPoll + 1);
    expect(
      response.items.some((item) => item.type === 'message' && item.role === 'assistant'),
    ).toBe(true);
  });

  it('still trips the doom-loop guard when request AND result are both identical', async () => {
    // The other half of the fix: folding results in must not defang the guard.
    // A tool whose output never changes is indistinguishable from a stuck model.
    const fakeClient = new PollingClient({
      toolName: 'check_build',
      toolArgs: '{"id":"build-7"}',
      stopAfterRounds: Number.MAX_SAFE_INTEGER,
    });
    let pollsServed = 0;
    const stuckPollTool = tool({
      name: 'check_build',
      description: 'Poll a build that never progresses',
      input: z.object({
        id: z.string(),
      }),
      output: z.object({
        status: z.string(),
      }),
      execute: async () => {
        pollsServed += 1;
        return {
          status: 'pending',
        };
      },
    });
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    frameworkCast<{
      client: PollingClient;
    }>(harness).client = fakeClient;
    const ctx = harness.createContext();

    await expect(
      harness.callModel({
        model: 'test/model',
        items: [
          makeMessage('user', 'wait for build-7'),
        ],
        tools: [
          stuckPollTool,
        ],
        ctx,
      }),
    ).rejects.toThrow('Doom loop detected');
    // Four identical rounds ran (1 + DOOM_LOOP_IDENTICAL_ROUNDS), then the
    // guard tripped at the top of the fifth before spending another call.
    expect(pollsServed).toBe(4);
    expect(fakeClient.calls).toBe(4);
  });

  it('disables the doom-loop guard entirely when doomLoopIdenticalRounds is 0', async () => {
    // An opt-out for poll-heavy agents whose tool output is genuinely constant.
    // Without the guard the run instead terminates via the tool-round limit.
    const fakeClient = new PollingClient({
      toolName: 'check_build',
      toolArgs: '{"id":"build-7"}',
      stopAfterRounds: Number.MAX_SAFE_INTEGER,
    });
    const constantPollTool = tool({
      name: 'check_build',
      description: 'Poll a build that never progresses',
      input: z.object({
        id: z.string(),
      }),
      output: z.object({
        status: z.string(),
      }),
      execute: async () => ({
        status: 'pending',
      }),
    });
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    frameworkCast<{
      client: PollingClient;
    }>(harness).client = fakeClient;
    const ctx = harness.createContext();

    await expect(
      harness.callModel({
        model: 'test/model',
        items: [
          makeMessage('user', 'wait for build-7'),
        ],
        tools: [
          constantPollTool,
        ],
        ctx,
        doomLoopIdenticalRounds: 0,
      }),
    ).rejects.toThrow('exceeded maximum tool rounds');
    // Ran far past the 4-round doom threshold — only MAX_TOOL_ROUNDS stopped it.
    expect(fakeClient.calls).toBeGreaterThan(30);
  });

  it('respects a custom doomLoopIdenticalRounds threshold', async () => {
    const fakeClient = new PollingClient({
      toolName: 'check_build',
      toolArgs: '{"id":"build-7"}',
      stopAfterRounds: Number.MAX_SAFE_INTEGER,
    });
    const constantPollTool = tool({
      name: 'check_build',
      description: 'Poll a build that never progresses',
      input: z.object({
        id: z.string(),
      }),
      output: z.object({
        status: z.string(),
      }),
      execute: async () => ({
        status: 'pending',
      }),
    });
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    frameworkCast<{
      client: PollingClient;
    }>(harness).client = fakeClient;
    const ctx = harness.createContext();

    await expect(
      harness.callModel({
        model: 'test/model',
        items: [
          makeMessage('user', 'wait for build-7'),
        ],
        tools: [
          constantPollTool,
        ],
        ctx,
        doomLoopIdenticalRounds: 8,
      }),
    ).rejects.toThrow('9 consecutive rounds of identical tool calls and results');
    // Threshold 8 means the 9th identical round trips — nine rounds executed.
    expect(fakeClient.calls).toBe(9);
  });

  it('pairs each parallel tool result with its own call, not by position', async () => {
    // Two parallel reads whose results are stable but DIFFERENT from each other.
    // A fingerprint that concatenated results positionally instead of joining on
    // callId would still be stable here, so the real assertion is the negative
    // one below: swapping which file returns which body must break the streak.
    class ParallelReadClient {
      calls = 0;
      callModel(): {
        getFullResponsesStream: () => AsyncIterable<unknown>;
        getResponse: () => Promise<MockModelResponse>;
      } {
        const callNumber = this.calls++;
        return {
          async *getFullResponsesStream() {},
          getResponse: async () =>
            frameworkCast<MockModelResponse>({
              id: `resp-${callNumber}`,
              status: 'completed',
              output: [
                {
                  id: `fc-a-${callNumber}`,
                  status: 'completed',
                  type: 'function_call',
                  callId: `call_a_${callNumber}`,
                  name: 'read_file',
                  arguments: '{"path":"a.txt"}',
                },
                {
                  id: `fc-b-${callNumber}`,
                  status: 'completed',
                  type: 'function_call',
                  callId: `call_b_${callNumber}`,
                  name: 'read_file',
                  arguments: '{"path":"b.txt"}',
                },
              ],
              usage: {
                inputTokens: 1,
                outputTokens: 1,
              },
            }),
        };
      }
    }
    const fakeClient = new ParallelReadClient();
    // Bodies swap between a.txt and b.txt on every round: the multiset of
    // results is constant, only the call→result pairing changes. Correct
    // pairing sees two distinct rounds and never trips; positional pairing
    // would see one repeated round and abort.
    let roundsServed = 0;
    const readFileTool = tool({
      name: 'read_file',
      description: 'Read a file',
      input: z.object({
        path: z.string(),
      }),
      output: z.object({
        body: z.string(),
      }),
      execute: async (args) => {
        // Two calls per round; flip the mapping each round.
        const swapped = Math.floor(roundsServed / 2) % 2 === 1;
        roundsServed += 1;
        const isA = args.path === 'a.txt';
        return {
          body: isA === swapped ? 'BODY-B' : 'BODY-A',
        };
      },
    });
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    frameworkCast<{
      client: ParallelReadClient;
    }>(harness).client = fakeClient;
    const ctx = harness.createContext();

    await expect(
      harness.callModel({
        model: 'test/model',
        items: [
          makeMessage('user', 'read both'),
        ],
        tools: [
          readFileTool,
        ],
        ctx,
      }),
    ).rejects.toThrow('exceeded maximum tool rounds');
    // Never tripped the doom guard: the alternating pairing kept every
    // consecutive pair of rounds distinct, so only MAX_TOOL_ROUNDS stopped it.
    expect(fakeClient.calls).toBeGreaterThan(30);
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
  it('yields framework item_appended items as complete, ignoring other framework events', async () => {
    const bc = new EventBroadcaster();
    const userItem: Item = {
      id: 'user-1',
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [
        {
          type: 'input_text',
          text: 'hi',
        },
      ],
    };
    const outputItem: Item = {
      id: 'out-1',
      type: 'function_call_output',
      status: 'completed',
      callId: 'call-1',
      output: '{"ok":true}',
    };

    queueMicrotask(() => {
      bc.emit({
        source: 'framework',
        type: 'agent:turn_started',
        data: {
          turnId: 't1',
          messageIds: [],
        },
      });
      bc.emit({
        source: 'framework',
        type: 'agent:item_appended',
        data: {
          item: userItem,
        },
      });
      bc.emit({
        source: 'framework',
        type: 'agent:item_appended',
        data: {
          item: outputItem,
        },
      });
      bc.complete();
    });

    const items = await collect(buildItemStream(bc));
    expect(items).toHaveLength(2);
    expect(items[0]?.isComplete).toBe(true);
    assert(items[0]?.type === 'message' && items[0].role === 'user');
    assert(items[1]?.type === 'function_call_output');
    expect(items[1].callId).toBe('call-1');
    expect(items[1].isComplete).toBe(true);
  });

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

  it('yields custom items registered through an item schema registry', async () => {
    const bc = new EventBroadcaster();
    const registry = new ItemSchemaRegistry({
      items: [
        z.object({
          type: z.literal('custom:progress'),
          id: z.string(),
          percent: z.number(),
        }),
      ],
    });

    emitAsync(bc, [
      sdkEvent('response.created', {}, undefined),
      sdkEvent(
        'response.output_item.added',
        {
          item: {
            type: 'custom:progress',
            id: 'progress-1',
            percent: 50,
          },
        },
        0,
      ),
      sdkEvent('response.output_item.done', {}, 0),
    ]);

    const items = await collect(buildItemStream(bc, registry));
    const last = items.at(-1);
    assert(last);
    expect(last).toMatchObject({
      type: 'custom:progress',
      id: 'progress-1',
      percent: 50,
      isComplete: true,
    });
  });

  it('preserves function_call extension fields in streamed snapshots', async () => {
    const bc = new EventBroadcaster();
    const registry = new ItemSchemaRegistry({
      toolCalls: [
        z.object({
          type: z.literal('function_call'),
          id: z.string(),
          status: z.string(),
          callId: z.string(),
          name: z.string(),
          arguments: z.string().optional(),
          display: z.object({
            label: z.string(),
          }),
        }),
      ],
    });

    emitAsync(bc, [
      sdkEvent('response.created', {}, undefined),
      sdkEvent(
        'response.output_item.added',
        {
          item: {
            type: 'function_call',
            id: 'fc-stream',
            status: 'in_progress',
            callId: 'call-stream',
            name: 'search',
            arguments: '',
            display: {
              label: 'Search web',
            },
          },
        },
        0,
      ),
      sdkEvent(
        'response.function_call_arguments.delta',
        {
          delta: '{"q":"noetic"}',
        },
        0,
      ),
      sdkEvent('response.function_call_arguments.done', {}, 0),
      sdkEvent('response.output_item.done', {}, 0),
    ]);

    const items = await collect(buildItemStream(bc, registry));
    const last = items.at(-1);
    assert(last);
    expect(last).toMatchObject({
      type: 'function_call',
      id: 'fc-stream',
      callId: 'call-stream',
      name: 'search',
      arguments: '{"q":"noetic"}',
      display: {
        label: 'Search web',
      },
      isComplete: true,
    });
  });
});

describe('AgentHarness — item schema extensions', () => {
  it('preserves harness-wide custom response items in getAgentResponse()', async () => {
    const CustomItemSchema = z.object({
      type: z.literal('custom:notice'),
      id: z.string(),
      text: z.string(),
    });
    const harness = new AgentHarness({
      name: 'test',
      agentGraph: echoStep,
      params: {},
      itemSchemas: {
        schemas: {
          items: [
            CustomItemSchema,
          ],
        },
      },
      _testCallModel: async () => ({
        items: [
          frameworkCast({
            type: 'custom:notice',
            id: 'custom-1',
            text: 'from adapter',
          }),
        ],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
        },
      }),
    });

    await harness.execute('hi');
    const response = await harness.getAgentResponse();

    expect(response.items).toContainEqual(
      expect.objectContaining({
        type: 'custom:notice',
        id: 'custom-1',
        text: 'from adapter',
      }),
    );
  });

  it('decorates harness-created tool result items before returning them', async () => {
    const ToolResultSchema = z.object({
      id: z.string(),
      status: z.literal('completed'),
      type: z.literal('function_call_output'),
      callId: z.string(),
      output: z.string(),
      card: z.object({
        title: z.string(),
        count: z.number(),
      }),
    });
    const countingTool = tool({
      name: 'count',
      description: 'Counts items',
      input: z.object({
        count: z.number(),
      }),
      output: z.object({
        count: z.number(),
      }),
      itemSchemas: {
        toolResults: [
          ToolResultSchema,
        ],
      },
      execute: async (args) => ({
        count: args.count,
      }),
      decorateResultItem: ({ baseItem, result }) => ({
        ...baseItem,
        card: {
          title: 'Count complete',
          count: result?.count ?? 0,
        },
      }),
    });
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const fakeClient = new DecoratingToolClient();
    frameworkCast<{
      client: DecoratingToolClient;
    }>(harness).client = fakeClient;
    const ctx = harness.createContext();

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'count'),
      ],
      tools: [
        countingTool,
      ],
      ctx,
    });

    expect(response.items).toContainEqual(
      expect.objectContaining({
        type: 'function_call_output',
        callId: 'call-count',
        card: {
          title: 'Count complete',
          count: 3,
        },
      }),
    );
  });

  it('uses harness-wide schemas for memory recall items', async () => {
    const CustomMemoryItemSchema = z.object({
      type: z.literal('custom:memory'),
      text: z.string(),
    });
    const harness = new AgentHarness({
      name: 'test',
      agentGraph: echoStep,
      params: {},
      itemSchemas: {
        schemas: {
          items: [
            CustomMemoryItemSchema,
          ],
        },
      },
      contextLayers: [
        {
          id: 'custom-memory',
          slot: 100,
          scope: 'execution',
          hooks: {
            recall: async () => ({
              tokenCount: 1,
              items: [
                frameworkCast({
                  type: 'custom:memory',
                  text: 'global schema item',
                }),
              ],
            }),
          },
        },
      ],
      _testCallModel: async (request) => {
        expect(request.items).toContainEqual(
          expect.objectContaining({
            type: 'custom:memory',
            text: 'global schema item',
          }),
        );
        return textOnlyResponse('done');
      },
    });

    await harness.execute('hi');
    await expect(harness.getAgentResponse()).resolves.toMatchObject({
      text: 'done',
    });
  });

  it('rejects decorated tool result items that miss the registered schema', async () => {
    const ToolResultSchema = z.object({
      id: z.string(),
      status: z.literal('completed'),
      type: z.literal('function_call_output'),
      callId: z.string(),
      output: z.string(),
      requiredCard: z.object({
        title: z.string(),
      }),
    });
    const invalidDecoratingTool = tool({
      name: 'count',
      description: 'Counts items',
      input: z.object({
        count: z.number(),
      }),
      output: z.object({
        count: z.number(),
      }),
      itemSchemas: {
        toolResults: [
          ToolResultSchema,
        ],
      },
      execute: async (args) => ({
        count: args.count,
      }),
      decorateResultItem: ({ baseItem }) => baseItem,
    });
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const fakeClient = new DecoratingToolClient();
    frameworkCast<{
      client: DecoratingToolClient;
    }>(harness).client = fakeClient;
    const ctx = harness.createContext();

    let caught: unknown;
    try {
      await harness.callModel({
        model: 'test/model',
        items: [
          makeMessage('user', 'count'),
        ],
        tools: [
          invalidDecoratingTool,
        ],
        ctx,
      });
    } catch (e) {
      caught = e;
    }
    assert(isNoeticError(caught));
    expect(caught.noeticError.kind).toBe('item_schema_mismatch');
    assert(caught.noeticError.kind === 'item_schema_mismatch');
    expect(caught.noeticError.category).toBe('toolResults');
  });

  it("one tool's toolResults schemas do not reject a plain sibling tool's results", async () => {
    const ToolResultSchema = z.object({
      id: z.string(),
      status: z.literal('completed'),
      type: z.literal('function_call_output'),
      callId: z.string(),
      output: z.string(),
      card: z.object({
        title: z.string(),
      }),
    });
    const schemaTool = tool({
      name: 'count',
      description: 'Counts items',
      input: z.object({
        count: z.number(),
      }),
      output: z.object({
        count: z.number(),
      }),
      itemSchemas: {
        toolResults: [
          ToolResultSchema,
        ],
      },
      execute: async (args) => ({
        count: args.count,
      }),
      decorateResultItem: ({ baseItem }) => ({
        ...baseItem,
        card: {
          title: 'Count complete',
        },
      }),
    });
    const plainTool = tool({
      name: 'ping',
      description: 'Pings',
      input: z.object({}),
      output: z.object({
        pong: z.boolean(),
      }),
      execute: async () => ({
        pong: true,
      }),
    });
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    // Model calls ONLY the plain tool; the schema-bearing sibling is merely registered.
    const fakeClient = new DecoratingToolClient('ping', '{}');
    frameworkCast<{
      client: DecoratingToolClient;
    }>(harness).client = fakeClient;
    const ctx = harness.createContext();

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'ping'),
      ],
      tools: [
        schemaTool,
        plainTool,
      ],
      ctx,
    });

    expect(response.items).toContainEqual(
      expect.objectContaining({
        type: 'function_call_output',
        callId: 'call-ping',
      }),
    );
    expect(response.usage.inputTokens).toBeGreaterThan(0);
  });

  it('decorated tool results keep framework id/status when the tool schema omits them', async () => {
    const PartialToolResultSchema = z.object({
      type: z.literal('function_call_output'),
      callId: z.string(),
      output: z.string(),
      card: z.object({
        title: z.string(),
      }),
    });
    const partialSchemaTool = tool({
      name: 'count',
      description: 'Counts items',
      input: z.object({
        count: z.number(),
      }),
      output: z.object({
        count: z.number(),
      }),
      itemSchemas: {
        toolResults: [
          PartialToolResultSchema,
        ],
      },
      execute: async (args) => ({
        count: args.count,
      }),
      decorateResultItem: ({ baseItem }) => ({
        ...baseItem,
        card: {
          title: 'Count complete',
        },
      }),
    });
    const harness = new AgentHarness({
      name: 'test',
      params: {},
    });
    const fakeClient = new DecoratingToolClient();
    frameworkCast<{
      client: DecoratingToolClient;
    }>(harness).client = fakeClient;
    const ctx = harness.createContext();

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'count'),
      ],
      tools: [
        partialSchemaTool,
      ],
      ctx,
    });

    const resultItem = response.items.find((i) => i.type === 'function_call_output');
    assert(resultItem);
    // Gate, not normalizer: the partial schema must not strip the
    // framework-generated id/status from the decorated item.
    expect(resultItem).toMatchObject({
      type: 'function_call_output',
      callId: 'call-count',
      status: 'completed',
      card: {
        title: 'Count complete',
      },
    });
    assert('id' in resultItem && typeof resultItem.id === 'string');
    expect(resultItem.id.length).toBeGreaterThan(0);
  });

  it('rejects unregistered extension response items by default', async () => {
    const harness = new AgentHarness({
      name: 'test',
      agentGraph: echoStep,
      params: {},
      _testCallModel: async () => ({
        items: [
          frameworkCast({
            type: 'custom:unregistered',
          }),
        ],
        usage: {
          inputTokens: 1,
          outputTokens: 1,
        },
      }),
    });

    await harness.execute('hi');
    await expect(harness.getAgentResponse()).rejects.toThrow(/registered item extension schema/);
  });
});

describe('AgentHarness — emit option', () => {
  it('emit: false suppresses framework events inside callModel', async () => {
    const silentStep: Step<ContextData, string, string> = {
      kind: 'callModel',
      id: 'silent',
      model: 'test/echo',
      tools: [],
      emit: false,
    };

    const harness = new AgentHarness({
      name: 'myagent',
      agentGraph: silentStep,
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
