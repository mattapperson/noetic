/**
 * The model-driven tool loop's `tool_call_completed` events must carry the
 * REAL outcome — a denied or throwing tool is `error: true` with the failure
 * text as `output`, and a successful one carries its output. Regression tests
 * for the hardcoded `error: false` that reported rejected tool calls as
 * successful to every stream consumer (ACP editors, chat cards).
 *
 * Also covers the tool-less streaming path: a `callModel` request WITHOUT
 * tools must still reach the broadcaster (`ctx` carries it) — previously the
 * request builder dropped `ctx` on that branch and a tool-less harness
 * streamed nothing.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { Context, ContextLayer, LLMResponse } from '@noetic-tools/types';
import { frameworkCast, SteeringAction } from '@noetic-tools/types';
import { z } from 'zod';
import { invokeTool } from '../../src/builders/step-builders';
import { tool, toolWithGenerator } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { execute } from '../../src/interpreter/execute';
import { makeMessage } from '../_helpers';

//#region Fakes

interface EmittedEvent {
  source: string;
  type: string;
  data: Record<string, unknown>;
}

function attachBroadcaster(ctx: Context, events: EmittedEvent[]): Context {
  return Object.assign(ctx, {
    _broadcaster: {
      emit: (event: EmittedEvent) => {
        events.push(event);
      },
    },
  });
}

type MockModelResponse = LLMResponse & {
  id: string;
  output: LLMResponse['items'];
  status?: string;
};

function finalMessageResponse(text: string): MockModelResponse {
  return frameworkCast<MockModelResponse>({
    id: 'resp-final',
    status: 'completed',
    output: [
      {
        id: 'msg-final',
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
    items: [],
    usage: {
      inputTokens: 5,
      outputTokens: 2,
    },
    cost: 0.001,
  });
}

/** Round 1 requests one tool call; round 2 finishes with a message. */
class ToolCallThenDoneClient {
  calls = 0;

  constructor(
    private readonly toolName: string,
    private readonly args: Record<string, unknown>,
  ) {}

  callModel(): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<MockModelResponse>;
  } {
    return {
      async *getFullResponsesStream() {},
      getResponse: async () => {
        this.calls += 1;
        if (this.calls === 1) {
          return frameworkCast<MockModelResponse>({
            id: 'resp-tool-call',
            status: 'completed',
            output: [
              {
                id: 'fc-1',
                status: 'completed',
                type: 'function_call',
                callId: 'call-1',
                name: this.toolName,
                arguments: JSON.stringify(this.args),
              },
            ],
            items: [],
            usage: {
              inputTokens: 5,
              outputTokens: 2,
            },
          });
        }
        return finalMessageResponse('done');
      },
    };
  }
}

/** Streams two text deltas, then resolves the final message. */
class StreamingTextClient {
  callModel(): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<MockModelResponse>;
  } {
    return {
      async *getFullResponsesStream() {
        yield {
          type: 'response.output_text.delta',
          delta: 'Par',
        };
        yield {
          type: 'response.output_text.delta',
          delta: 'is',
        };
      },
      getResponse: async () => finalMessageResponse('Paris'),
    };
  }
}

function installClient(harness: AgentHarness<Record<string, never>>, client: unknown): void {
  frameworkCast<{
    llm: {
      client: unknown;
    };
  }>(harness).llm.client = client;
}

function completedEvents(events: EmittedEvent[], agentName: string): EmittedEvent[] {
  return events.filter((e) => e.type === `${agentName}:tool_call_completed`);
}

const AddInput = z.object({
  a: z.number(),
  b: z.number(),
});

//#endregion

describe('model-path tool_call_completed forwards the real outcome', () => {
  it('a successful tool completes with error: false and its output', async () => {
    const harness = new AgentHarness({
      name: 'evt',
      params: {},
    });
    installClient(
      harness,
      new ToolCallThenDoneClient('add', {
        a: 2,
        b: 3,
      }),
    );
    const events: EmittedEvent[] = [];
    const ctx = attachBroadcaster(harness.createContext(), events);

    await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'add'),
      ],
      tools: [
        tool({
          name: 'add',
          description: 'Add',
          input: AddInput,
          output: z.object({
            sum: z.number(),
          }),
          execute: async (args) => ({
            sum: args.a + args.b,
          }),
        }),
      ],
      ctx,
    });

    const completed = completedEvents(events, 'evt');
    expect(completed).toHaveLength(1);
    const event = completed[0];
    assert(event);
    expect(event.data.error).toBe(false);
    assert(typeof event.data.output === 'string');
    expect(event.data.output).toContain('5');
  });

  it('a throwing tool completes with error: true and the failure text', async () => {
    const harness = new AgentHarness({
      name: 'evt',
      params: {},
    });
    installClient(harness, new ToolCallThenDoneClient('boom', {}));
    const events: EmittedEvent[] = [];
    const ctx = attachBroadcaster(harness.createContext(), events);

    await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'go'),
      ],
      tools: [
        tool({
          name: 'boom',
          description: 'Always fails',
          input: z.object({}),
          output: z.object({}),
          execute: async () => {
            throw new Error('boom tool always fails');
          },
        }),
      ],
      ctx,
    });

    const completed = completedEvents(events, 'evt');
    expect(completed).toHaveLength(1);
    const event = completed[0];
    assert(event);
    expect(event.data.error).toBe(true);
    assert(typeof event.data.output === 'string');
    expect(event.data.output).toContain('boom tool always fails');
  });

  it('a gate-denied tool completes with error: true carrying the refusal', async () => {
    const harness = new AgentHarness({
      name: 'evt',
      params: {},
    });
    installClient(
      harness,
      new ToolCallThenDoneClient('add', {
        a: 1,
        b: 1,
      }),
    );
    const events: EmittedEvent[] = [];
    const ctx = attachBroadcaster(harness.createContext(), events);
    const denyLayer = frameworkCast<ContextLayer>({
      id: 'deny-all',
      slot: 0,
      scope: 'execution',
      hooks: {
        beforeToolCall: async () => ({
          decision: {
            action: SteeringAction.Deny,
            guidance: 'not allowed here',
          },
        }),
      },
    });

    await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'add'),
      ],
      tools: [
        tool({
          name: 'add',
          description: 'Add',
          input: AddInput,
          output: z.object({
            sum: z.number(),
          }),
          execute: async (args) => ({
            sum: args.a + args.b,
          }),
        }),
      ],
      ctx,
      layers: [
        denyLayer,
      ],
    });

    const completed = completedEvents(events, 'evt');
    expect(completed).toHaveLength(1);
    const event = completed[0];
    assert(event);
    expect(event.data.error).toBe(true);
    assert(typeof event.data.output === 'string');
    expect(event.data.output).toContain('not allowed here');
  });
});

describe('tool-less callModel still streams', () => {
  it('sdk stream events reach the broadcaster without tools on the request', async () => {
    const harness = new AgentHarness({
      name: 'evt',
      params: {},
    });
    installClient(harness, new StreamingTextClient());
    const events: EmittedEvent[] = [];
    const ctx = attachBroadcaster(harness.createContext(), events);

    const response = await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'capital of France?'),
      ],
      ctx,
    });

    expect(response).toBeDefined();
    const deltas = events.filter(
      (e) => e.source === 'sdk' && e.type === 'response.output_text.delta',
    );
    expect(deltas.map((e) => e.data.delta)).toEqual([
      'Par',
      'is',
    ]);
  });
});

describe('model-path tool calls carry the tool presentation', () => {
  function presentingTool(fail: boolean) {
    return toolWithGenerator({
      name: 'write',
      description: 'Write a file',
      input: z.object({
        path: z.string(),
      }),
      event: z.number(),
      output: z.object({
        path: z.string(),
      }),
      presentation: {
        kind: 'edit',
        title: ({ path }) => `Write ${path}`,
        locations: ({ path }) => [
          path,
        ],
        progress: (events) => ({
          progress: events.length,
          status: 'in_progress',
        }),
        content: ({ path }) => [
          {
            type: 'diff',
            path,
            oldText: null,
            newText: 'x',
          },
        ],
      },
      async *execute({ path }) {
        yield 1;
        if (fail) {
          throw new Error('disk full');
        }
        return {
          path,
        };
      },
    });
  }

  async function run(fail: boolean, args: Record<string, unknown>): Promise<EmittedEvent[]> {
    const harness = new AgentHarness({
      name: 'evt',
      params: {},
    });
    installClient(harness, new ToolCallThenDoneClient('write', args));
    const events: EmittedEvent[] = [];
    const ctx = attachBroadcaster(harness.createContext(), events);
    await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'write'),
      ],
      tools: [
        presentingTool(fail),
      ],
      ctx,
    });
    return events;
  }

  function data(events: EmittedEvent[], name: string): Array<Record<string, unknown>> {
    return events.filter((e) => e.type === `evt:${name}`).map((e) => e.data);
  }

  it('starts a call with its title, kind and locations, reports progress, and completes with content', async () => {
    const events = await run(false, {
      path: 'a.ts',
    });
    expect(data(events, 'tool_call_started')).toEqual([
      {
        name: 'write',
        callId: 'call-1',
        toolId: 'write',
        kind: 'edit',
        title: 'Write a.ts',
        locations: [
          {
            path: 'a.ts',
          },
        ],
      },
    ]);
    expect(data(events, 'tool_progress')).toEqual([
      {
        name: 'write',
        callId: 'call-1',
        toolId: 'write',
        event: 1,
        progress: 1,
        status: 'in_progress',
      },
    ]);
    expect(data(events, 'tool_call_completed')[0]?.content).toEqual([
      {
        type: 'diff',
        path: 'a.ts',
        oldText: null,
        newText: 'x',
      },
    ]);
  });

  it('gives a failed call no content, and a call whose arguments do not parse its kind only', async () => {
    const failed = await run(true, {
      path: 'a.ts',
    });
    const completed = data(failed, 'tool_call_completed')[0];
    expect(completed?.error).toBe(true);
    expect(completed).not.toHaveProperty('content');

    const harness = new AgentHarness({
      name: 'evt',
      params: {},
    });
    installClient(
      harness,
      frameworkCast<unknown>({
        calls: 0,
        callModel() {
          const client = frameworkCast<{
            calls: number;
          }>(this);
          return {
            async *getFullResponsesStream() {},
            getResponse: async () => {
              client.calls += 1;
              return client.calls === 1
                ? frameworkCast<MockModelResponse>({
                    id: 'r',
                    status: 'completed',
                    output: [
                      {
                        id: 'fc',
                        status: 'completed',
                        type: 'function_call',
                        callId: 'call-bad',
                        name: 'write',
                        arguments: '{not json',
                      },
                    ],
                    items: [],
                    usage: {
                      inputTokens: 1,
                      outputTokens: 1,
                    },
                  })
                : finalMessageResponse('done');
            },
          };
        },
      }),
    );
    const events: EmittedEvent[] = [];
    const ctx = attachBroadcaster(harness.createContext(), events);
    await harness.callModel({
      model: 'test/model',
      items: [
        makeMessage('user', 'write'),
      ],
      tools: [
        presentingTool(false),
      ],
      ctx,
    });
    expect(data(events, 'tool_call_started')).toEqual([
      {
        name: 'write',
        callId: 'call-bad',
        toolId: 'write',
        kind: 'edit',
      },
    ]);
  });
});

describe('invokeTool calls carry the tool presentation', () => {
  it('starts with the declared title, kind and locations, and completes with content', async () => {
    const harness = new AgentHarness({
      name: 'evt',
      params: {},
    });
    const events: EmittedEvent[] = [];
    const ctx = attachBroadcaster(harness.createContext(), events);
    const write = tool({
      name: 'write',
      description: 'Write a file',
      input: z.object({
        path: z.string(),
      }),
      output: z.object({
        path: z.string(),
      }),
      presentation: {
        kind: 'edit',
        title: ({ path }) => `Write ${path}`,
        content: ({ path }) => [
          {
            type: 'diff',
            path,
            oldText: null,
            newText: 'x',
          },
        ],
      },
      execute: async ({ path }) => ({
        path,
      }),
    });
    await execute(
      invokeTool({
        id: 'write-step',
        tool: write,
      }),
      {
        path: 'a.ts',
      },
      ctx,
    );
    const started = events.find((e) => e.type === 'evt:tool_call_started');
    expect(started?.data).toEqual({
      name: 'write',
      callId: 'write-step',
      toolId: 'write',
      kind: 'edit',
      title: 'Write a.ts',
    });
    const completed = events.find((e) => e.type === 'evt:tool_call_completed');
    expect(completed?.data.content).toEqual([
      {
        type: 'diff',
        path: 'a.ts',
        oldText: null,
        newText: 'x',
      },
    ]);
  });
});
