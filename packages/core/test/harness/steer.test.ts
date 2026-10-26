/**
 * Steers: messages sent into a running model call with `deliveryMode`
 * `between-rounds` or `next-item`. Covers where they land in the conversation,
 * the item-boundary stream cut, and the `onSteer` layer hook.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  AgentHarnessContract,
  CallModelRequest,
  Context,
  ContextData,
  ContextLayer,
  DeliveryMode,
  ExecuteInput,
  Item,
  LLMResponse,
  OnSteerParams,
  OnSteerResult,
  Step,
  StreamEvent,
  Tool,
} from '@noetic-tools/types';
import { frameworkCast, SteerAction, SteerPoint } from '@noetic-tools/types';
import { z } from 'zod';
import { tool } from '../../src/builders/tool-builder';
import { AgentHarness } from '../../src/harness/agent-harness';
import { openSteerInbox, SteerInbox } from '../../src/harness/steer-inbox';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';
import type { QueuedMessage, SessionCtxExtension } from '../../src/runtime/message-queue';
import { MessageQueue } from '../../src/runtime/message-queue';
import { makeMessage } from '../_helpers';

//#region Fakes

interface EmittedEvent {
  source: string;
  type: string;
  data: Record<string, unknown>;
}

interface ScriptedRound {
  output: Item[];
  /** Runs before the stream reports item `index` as done. */
  beforeDone?: (index: number) => void;
  /** Resolve the response without waiting for the stream to finish. */
  responseFirst?: boolean;
}

/** Streams each round's items one by one, then resolves the response. A round
 *  cut by a steer never resolves; the harness abandons it on abort. */
class ScriptedClient {
  readonly inputs: unknown[][] = [];

  constructor(private readonly rounds: ScriptedRound[]) {}

  callModel(params: { input: unknown[] }): {
    getFullResponsesStream: () => AsyncIterable<unknown>;
    getResponse: () => Promise<unknown>;
  } {
    const round = this.rounds[this.inputs.length];
    assert(round, `no scripted round ${this.inputs.length}`);
    this.inputs.push([
      ...params.input,
    ]);
    let finish: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      async *getFullResponsesStream() {
        for (const [index, item] of round.output.entries()) {
          yield {
            type: 'response.output_item.added',
            outputIndex: index,
            item,
          };
          round.beforeDone?.(index);
          yield {
            type: 'response.output_item.done',
            outputIndex: index,
            item,
          };
        }
        finish();
      },
      getResponse: async () => {
        if (!round.responseFirst) {
          await finished;
        }
        return {
          id: `resp-${crypto.randomUUID()}`,
          status: 'completed',
          output: round.output,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
          },
        };
      },
    };
  }
}

function assistant(text: string): Item {
  return makeMessage('assistant', text, `msg-${text}`);
}

function functionCall(callId: string, name: string): Item {
  return frameworkCast<Item>({
    id: `fc-${callId}`,
    status: 'completed',
    type: 'function_call',
    callId,
    name,
    arguments: '{}',
  });
}

function queued(input: ExecuteInput, deliveryMode: DeliveryMode, id = 'steer-1'): QueuedMessage {
  return {
    id,
    input,
    deliveryMode,
    options: {},
    enqueuedAt: Date.now(),
  };
}

interface Rig {
  harness: AgentHarness<Record<string, never>>;
  client: ScriptedClient;
  queue: MessageQueue;
  ctx: Context;
  events: EmittedEvent[];
}

/** A harness on a scripted client, and a context wired to a session queue. */
function makeRig(rounds: ScriptedRound[], contextLayers?: ContextLayer[]): Rig {
  const harness = new AgentHarness({
    name: 'steer',
    params: {},
  });
  const client = new ScriptedClient(rounds);
  frameworkCast<{
    client: unknown;
  }>(harness).client = client;
  const queue = new MessageQueue();
  const events: EmittedEvent[] = [];
  const ctx = Object.assign(
    harness.createContext({
      contextLayers,
    }),
    {
      _sessionQueue: queue,
      _broadcaster: {
        emit: (event: EmittedEvent) => {
          events.push(event);
        },
      },
    } satisfies SessionCtxExtension & Record<string, unknown>,
  );
  return {
    harness,
    client,
    queue,
    ctx,
    events,
  };
}

function eventsOf(events: EmittedEvent[], name: string): EmittedEvent[] {
  return events.filter((e) => e.type === `steer:${name}`);
}

function noopTool(name: string, onRun?: () => void): Tool {
  return tool({
    name,
    description: name,
    input: z.object({}),
    output: z.object({}),
    execute: async () => {
      onRun?.();
      return {};
    },
  });
}

function steerLayer(
  onSteer: (params: OnSteerParams) => Promise<OnSteerResult>,
  slot = 0,
  id = 'steer-policy',
): ContextLayer {
  return frameworkCast<ContextLayer>({
    id,
    slot,
    scope: 'execution',
    hooks: {
      onSteer,
    },
  });
}

function callWith(
  rig: Rig,
  extra: {
    tools?: Tool[];
    layers?: ContextLayer[];
  } = {},
): Promise<LLMResponse> {
  const request = {
    model: 'test/model',
    items: [
      makeMessage('user', 'start'),
    ],
    ctx: rig.ctx,
    layers: extra.layers,
  };
  return rig.harness.callModel(
    extra.tools
      ? {
          ...request,
          tools: extra.tools,
        }
      : request,
  );
}

function ids(items: ReadonlyArray<Item>): unknown[] {
  return items.map((item) => ('id' in item ? item.id : item.type));
}

function wireTypes(input: unknown[] | undefined): string[] {
  assert(input);
  return input.map((entry) => {
    // The wire omits `type` on messages; a role marks one.
    const record = frameworkCast<{
      type?: string;
      role?: string;
    }>(entry);
    return record.role ? `message:${record.role}` : String(record.type);
  });
}

//#endregion

describe('between-rounds steers', () => {
  it('lands before the next round, in model order, with its content and role intact', async () => {
    const steer: Item = {
      id: 'steer-item',
      type: 'message',
      role: 'developer',
      status: 'completed',
      content: [
        {
          type: 'input_text',
          text: 'use staging',
        },
        {
          type: 'input_image',
          detail: 'auto',
          imageUrl: 'https://example.com/diagram.png',
        },
      ],
    };
    const rig = makeRig([
      {
        output: [
          functionCall('call-1', 'lookup'),
        ],
      },
      {
        output: [
          assistant('done'),
        ],
      },
    ]);

    const response = await callWith(rig, {
      tools: [
        noopTool('lookup', () => rig.queue.enqueue(queued(steer, 'between-rounds'))),
      ],
    });

    expect(ids(response.items)).toEqual([
      'fc-call-1',
      expect.any(String),
      'steer-item',
      'msg-done',
    ]);
    expect(response.items[2]).toEqual(steer);
    expect(wireTypes(rig.client.inputs[1])).toEqual([
      'message:user',
      'function_call',
      'function_call_output',
      'message:developer',
    ]);
    expect(rig.queue.size).toBe(0);
    const injected = eventsOf(rig.events, 'inbox_injected');
    expect(injected).toHaveLength(1);
    expect(injected[0]?.data).toEqual({
      round: 1,
      count: 1,
      messageIds: [
        'steer-1',
      ],
    });
  });

  it('applies a steer queued before the first model call', async () => {
    const rig = makeRig([
      {
        output: [
          assistant('ok'),
        ],
      },
    ]);
    rig.queue.enqueue(queued('early', 'between-rounds'));

    const response = await callWith(rig);

    expect(wireTypes(rig.client.inputs[0])).toEqual([
      'message:user',
      'message:user',
    ]);
    expect(response.items).toHaveLength(2);
    expect(eventsOf(rig.events, 'inbox_injected')[0]?.data.round).toBe(0);
  });

  it('leaves a steer that arrives during the final answer for the next turn', async () => {
    const rig = makeRig([
      {
        output: [
          assistant('final'),
        ],
        beforeDone: () => rig.queue.enqueue(queued('late', 'between-rounds')),
      },
    ]);

    const response = await callWith(rig);

    expect(rig.client.inputs).toHaveLength(1);
    expect(ids(response.items)).toEqual([
      'msg-final',
    ]);
    expect(rig.queue.size).toBe(1);
  });

  it('leaves next-turn messages in the queue', async () => {
    const rig = makeRig([
      {
        output: [
          assistant('ok'),
        ],
      },
    ]);
    rig.queue.enqueue(queued('later', 'next-turn'));

    await callWith(rig);

    expect(rig.client.inputs[0]).toHaveLength(1);
    expect(rig.queue.size).toBe(1);
  });

  it('reports a steer held behind pending tool calls once', async () => {
    const rig = makeRig([
      {
        output: [
          functionCall('call-1', 'first'),
          functionCall('call-2', 'second'),
          functionCall('call-3', 'third'),
        ],
      },
      {
        output: [
          assistant('done'),
        ],
      },
    ]);

    await callWith(rig, {
      tools: [
        noopTool('first', () => rig.queue.enqueue(queued('wait', 'between-rounds'))),
        noopTool('second'),
        noopTool('third'),
      ],
    });

    const pending = eventsOf(rig.events, 'steer_pending');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.data).toEqual({
      messageId: 'steer-1',
      waitingOn: [
        'call-2',
        'call-3',
      ],
    });
  });
});

describe('next-item steers', () => {
  it('stops the stream after the current item and continues with the steer', async () => {
    const rig = makeRig([
      {
        output: [
          assistant('first-thought'),
          assistant('never-sent'),
        ],
        beforeDone: (index) => {
          if (index === 0) {
            rig.queue.enqueue(queued('change course', 'next-item'));
          }
        },
      },
      {
        output: [
          assistant('changed'),
        ],
      },
    ]);

    const response = await callWith(rig);

    expect(ids(response.items)).toEqual([
      'msg-first-thought',
      expect.any(String),
      'msg-changed',
    ]);
    expect(wireTypes(rig.client.inputs[1])).toEqual([
      'message:user',
      'message:assistant',
      'message:user',
    ]);
    const steered = eventsOf(rig.events, 'model_call_steered');
    expect(steered).toHaveLength(1);
    expect(steered[0]?.data).toEqual({
      round: 0,
      itemCount: 1,
    });
    expect(eventsOf(rig.events, 'stream_pipe_error')).toHaveLength(0);
    // The cut round reports no usage; only the finished round counts.
    expect(response.rounds).toHaveLength(1);
  });

  it('answers a steer staged after the final answer completed in a further round', async () => {
    const rig = makeRig([
      {
        output: [
          assistant('final'),
        ],
        responseFirst: true,
        beforeDone: () => rig.queue.enqueue(queued('one more thing', 'next-item')),
      },
      {
        output: [
          assistant('follow-up'),
        ],
      },
    ]);

    const response = await callWith(rig);

    expect(ids(response.items)).toEqual([
      'msg-final',
      expect.any(String),
      'msg-follow-up',
    ]);
    expect(wireTypes(rig.client.inputs[1])).toEqual([
      'message:user',
      'message:assistant',
      'message:user',
    ]);
  });

  it('runs finished tool calls from a cut round before the steer', async () => {
    let ran = 0;
    const rig = makeRig([
      {
        output: [
          functionCall('call-1', 'lookup'),
          assistant('never-sent'),
        ],
        beforeDone: (index) => {
          if (index === 0) {
            rig.queue.enqueue(queued('stop', 'next-item'));
          }
        },
      },
      {
        output: [
          assistant('stopped'),
        ],
      },
    ]);

    await callWith(rig, {
      tools: [
        noopTool('lookup', () => {
          ran += 1;
        }),
      ],
    });

    expect(ran).toBe(1);
    expect(wireTypes(rig.client.inputs[1])).toEqual([
      'message:user',
      'function_call',
      'function_call_output',
      'message:user',
    ]);
  });
});

describe('onSteer layers', () => {
  it('can apply a steer before a tool call, skipping the rest of the round', async () => {
    const ran: string[] = [];
    const rig = makeRig([
      {
        output: [
          functionCall('call-1', 'first'),
          functionCall('call-2', 'second'),
        ],
      },
      {
        output: [
          assistant('done'),
        ],
      },
    ]);
    const layer = steerLayer(async ({ point, pendingCalls }) => {
      if (point !== SteerPoint.BeforeToolCall) {
        return {};
      }
      expect(pendingCalls.map((call) => call.callId)).toEqual([
        'call-2',
      ]);
      return {
        action: SteerAction.Apply,
      };
    });

    const response = await callWith(rig, {
      layers: [
        layer,
      ],
      tools: [
        noopTool('first', () => {
          ran.push('first');
          rig.queue.enqueue(queued('stop', 'between-rounds'));
        }),
        noopTool('second', () => ran.push('second')),
      ],
    });

    expect(ran).toEqual([
      'first',
    ]);
    const skipped = response.items.find(
      (item) => item.type === 'function_call_output' && item.callId === 'call-2',
    );
    assert(skipped && skipped.type === 'function_call_output');
    expect(skipped.output).toContain('Skipped');
    expect(wireTypes(rig.client.inputs[1]).at(-1)).toBe('message:user');
  });

  it('can drop a steer', async () => {
    const rig = makeRig([
      {
        output: [
          assistant('ok'),
        ],
      },
    ]);
    rig.queue.enqueue(queued('noise', 'between-rounds'));

    await callWith(rig, {
      layers: [
        steerLayer(async () => ({
          action: SteerAction.Drop,
        })),
      ],
    });

    expect(rig.client.inputs[0]).toHaveLength(1);
    expect(rig.queue.size).toBe(0);
    expect(eventsOf(rig.events, 'steer_dropped')[0]?.data).toEqual({
      messageId: 'steer-1',
      point: SteerPoint.BeforeRound,
    });
  });

  it('can defer a steer past the first round', async () => {
    const rig = makeRig([
      {
        output: [
          functionCall('call-1', 'lookup'),
        ],
      },
      {
        output: [
          assistant('done'),
        ],
      },
    ]);
    rig.queue.enqueue(queued('later please', 'between-rounds'));
    let offers = 0;

    await callWith(rig, {
      layers: [
        steerLayer(async ({ point }) => {
          if (point !== SteerPoint.BeforeRound) {
            return {};
          }
          offers += 1;
          return offers === 1
            ? {
                action: SteerAction.Defer,
              }
            : {};
        }),
      ],
      tools: [
        noopTool('lookup'),
      ],
    });

    expect(rig.client.inputs[0]).toHaveLength(1);
    expect(wireTypes(rig.client.inputs[1]).at(-1)).toBe('message:user');
  });

  it('runs layers in slot order, each seeing the previous rewrite', async () => {
    const rig = makeRig([
      {
        output: [
          assistant('ok'),
        ],
      },
    ]);
    rig.queue.enqueue(queued('raw', 'between-rounds'));
    const seen: string[] = [];

    const response = await callWith(rig, {
      layers: [
        steerLayer(
          async ({ steer }) => {
            seen.push(`second:${steer.items.length}`);
            return {
              items: [
                ...steer.items,
                makeMessage('developer', 'appended'),
              ],
            };
          },
          2,
          'second',
        ),
        steerLayer(
          async () => {
            seen.push('first');
            return {
              items: [
                makeMessage('developer', 'rewritten'),
              ],
            };
          },
          1,
          'first',
        ),
      ],
    });

    expect(seen).toEqual([
      'first',
      'second:1',
    ]);
    expect(ids(response.items)).toEqual([
      'msg-rewritten',
      'msg-appended',
      'msg-ok',
    ]);
  });

  it('keeps the steer unchanged when a hook throws', async () => {
    const rig = makeRig([
      {
        output: [
          assistant('ok'),
        ],
      },
    ]);
    rig.queue.enqueue(queued('keep me', 'between-rounds'));

    await callWith(rig, {
      layers: [
        steerLayer(async () => {
          throw new Error('policy crashed');
        }),
      ],
    });

    expect(wireTypes(rig.client.inputs[0])).toEqual([
      'message:user',
      'message:user',
    ]);
  });
});

describe('steers that ask for recall', () => {
  interface RecallLog {
    queries: string[];
  }

  /** Renders `recall #<n>` and asks for recall on every steer. */
  function recallingLayer(log: RecallLog, slot = 0, asks = true): ContextLayer {
    return frameworkCast<ContextLayer>({
      id: `recalling-${slot}`,
      slot,
      scope: 'execution',
      hooks: {
        recall: async ({ query }: { query: string }) => {
          log.queries.push(query);
          return `recall #${log.queries.length}`;
        },
        onSteer: async () =>
          asks
            ? {
                recall: true,
              }
            : {},
      },
    });
  }

  const lookupStep = (rig: Rig): Step<ContextData, string, string> => ({
    kind: 'callModel',
    id: 'agent',
    model: 'test/model',
    tools: [
      noopTool('lookup', () => rig.queue.enqueue(queued('the data is stale', 'between-rounds'))),
    ],
  });

  it('ends the call at the round boundary, recalls for the steer, and goes on', async () => {
    const log: RecallLog = {
      queries: [],
    };
    const rig = makeRig(
      [
        {
          output: [
            functionCall('call-1', 'lookup'),
          ],
        },
        {
          output: [
            assistant('fresh answer'),
          ],
        },
      ],
      [
        recallingLayer(log),
      ],
    );

    const result = await rig.harness.run(lookupStep(rig), 'go', rig.ctx);

    expect(result).toBe('fresh answer');
    // Two model requests: the steer stopped the call before a second one was sent.
    expect(rig.client.inputs).toHaveLength(2);
    expect(log.queries).toEqual([
      'go',
      'the data is stale',
    ]);
    // Anchoring keeps the first render pinned for the prompt cache; the new one
    // arrives after the steer as an update that supersedes it.
    const continued = JSON.stringify(rig.client.inputs[1]);
    expect(continued).toContain('call-1');
    expect(continued.indexOf('recall #2')).toBeGreaterThan(continued.indexOf('the data is stale'));
    // The log keeps the call's work and the steer in the order they happened.
    expect(ids(rig.ctx.itemLog.items).slice(-4)).toEqual([
      'fc-call-1',
      expect.any(String),
      'steer-steer-1',
      'msg-fresh answer',
    ]);
  });

  it('recalls when any layer asks', async () => {
    const log: RecallLog = {
      queries: [],
    };
    const rig = makeRig(
      [
        {
          output: [
            functionCall('call-1', 'lookup'),
          ],
        },
        {
          output: [
            assistant('done'),
          ],
        },
      ],
      [
        recallingLayer(log, 1),
        recallingLayer(
          {
            queries: [],
          },
          2,
          false,
        ),
      ],
    );

    await rig.harness.run(lookupStep(rig), 'go', rig.ctx);

    expect(log.queries).toHaveLength(2);
  });

  it('runs recall once when no layer asks', async () => {
    const log: RecallLog = {
      queries: [],
    };
    const rig = makeRig(
      [
        {
          output: [
            functionCall('call-1', 'lookup'),
          ],
        },
        {
          output: [
            assistant('done'),
          ],
        },
      ],
      [
        recallingLayer(log, 0, false),
      ],
    );

    await rig.harness.run(lookupStep(rig), 'go', rig.ctx);

    expect(log.queries).toEqual([
      'go',
    ]);
    expect(rig.client.inputs).toHaveLength(2);
  });
});

describe('a harness without onSteer', () => {
  it('applies steers at their default point and appends them unchanged', async () => {
    const queue = new MessageQueue();
    queue.enqueue(queued('use staging', 'next-item'));
    const harness = new AgentHarness({
      name: 'steer',
      params: {},
    });
    const inbox = new SteerInbox({
      queue,
      ctx: harness.createContext(),
      layers: [
        steerLayer(async () => ({
          action: SteerAction.Drop,
        })),
      ],
      harness: frameworkCast<AgentHarnessContract>({
        ...harness,
        onSteer: undefined,
        runAppendPipeline: harness.runAppendPipeline.bind(harness),
      }),
      emit: () => {},
      inConversation: () => false,
    });

    expect(await inbox.offer(SteerPoint.ItemDone)).toBe(true);
    const staged = inbox.takeStaged();
    expect(staged.messageIds).toEqual([
      'steer-1',
    ]);
    expect(staged.items).toHaveLength(1);
    expect(queue.size).toBe(0);
  });
});

describe('openSteerInbox', () => {
  function sessionCtx(): {
    harness: AgentHarness<Record<string, never>>;
    root: Context;
  } {
    const harness = new AgentHarness({
      name: 'steer',
      params: {},
    });
    const root = Object.assign(harness.createContext(), {
      _sessionQueue: new MessageQueue(),
    } satisfies SessionCtxExtension);
    return {
      harness,
      root,
    };
  }

  const inboxOpts = {
    layers: [],
    emit: () => {},
    inConversation: () => false,
  };

  it('returns nothing outside a session', () => {
    const harness = new AgentHarness({
      name: 'steer',
      params: {},
    });
    expect(
      openSteerInbox({
        ...inboxOpts,
        harness,
        ctx: harness.createContext(),
      }),
    ).toBeUndefined();
    expect(
      openSteerInbox({
        ...inboxOpts,
        harness,
        ctx: undefined,
      }),
    ).toBeUndefined();
  });

  it('holds steers from child contexts unless they forward', () => {
    const { harness, root } = sessionCtx();
    const held = harness.createContext({
      parent: root,
    });
    const forwarded = Object.assign(
      harness.createContext({
        parent: root,
      }),
      {
        _forwardSteers: true,
      } satisfies SessionCtxExtension,
    );

    expect(
      openSteerInbox({
        ...inboxOpts,
        harness,
        ctx: held,
      }),
    ).toBeUndefined();
    expect(
      openSteerInbox({
        ...inboxOpts,
        harness,
        ctx: forwarded,
      }),
    ).toBeDefined();
  });
});

describe('spawn steers option', () => {
  const childStep: Step = {
    kind: 'callModel',
    id: 'child-call',
    model: 'test/model',
  };

  async function runSpawn(steers: 'forward' | undefined): Promise<Rig> {
    const rig = makeRig([
      {
        output: [
          assistant('child'),
        ],
      },
    ]);
    rig.queue.enqueue(queued('for the child', 'between-rounds'));
    await rig.harness.run(
      {
        kind: 'spawn',
        id: 'worker',
        child: childStep,
        steers,
      },
      'go',
      rig.ctx,
    );
    return rig;
  }

  it('forwards session steers to the child when asked', async () => {
    const rig = await runSpawn('forward');
    expect(rig.queue.size).toBe(0);
    expect(wireTypes(rig.client.inputs[0]).filter((t) => t === 'message:user')).toHaveLength(2);
  });

  it('holds them by default', async () => {
    const rig = await runSpawn(undefined);
    expect(rig.queue.size).toBe(1);
  });
});

describe('session delivery', () => {
  function textResponse(text: string, extra: Item[] = []): LLMResponse {
    return {
      items: [
        ...extra,
        assistant(text),
      ],
      usage: {
        inputTokens: 1,
        outputTokens: 1,
      },
    };
  }

  const echoStep: Step<ContextData, string, string> = {
    kind: 'callModel',
    id: 'echo',
    model: 'test/echo',
  };

  async function collectUntil(
    stream: AsyncIterable<StreamEvent>,
    lastType: string,
  ): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === lastType) {
        break;
      }
    }
    return events;
  }

  it('announces a mid-turn steer with steer_accepted, but not a next-turn message', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const harness = new AgentHarness({
      name: 'steer',
      agentGraph: echoStep,
      params: {},
      _testCallModel: async () => {
        calls += 1;
        await gate;
        return textResponse('ok');
      },
    });
    const stream = harness.getFullStream();
    await harness.execute('first');
    while (calls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await harness.execute('steer', {
      deliveryMode: 'next-item',
      messageId: 'm-steer',
    });
    await harness.execute('queued', {
      messageId: 'm-next',
    });
    release();
    await harness.getAgentResponse();

    const events = await collectUntil(stream, 'steer:turn_completed');
    const accepted = events.filter((e) => e.type === 'steer:steer_accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.data).toMatchObject({
      messageId: 'm-steer',
      deliveryMode: 'next-item',
    });
  });

  it.each([
    [
      'in memory',
      undefined,
    ],
    [
      'in durable storage',
      {
        storage: {
          adapter: createInMemoryStorage(),
        },
      },
    ],
  ])('interrupt keeps the finished items of the turn it cuts, %s', async (_label, environment) => {
    const requests: CallModelRequest[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = new AgentHarness({
      name: 'steer',
      agentGraph: echoStep,
      params: {},
      environment,
      _testCallModel: async (request) => {
        requests.push(request);
        if (requests.length > 1) {
          return textResponse('second answer');
        }
        await gate;
        // The rounds finished before the cut: one tool call answered, one not.
        return textResponse('partial', [
          functionCall('call-1', 'lookup'),
          frameworkCast<Item>({
            id: 'out-1',
            type: 'function_call_output',
            status: 'completed',
            callId: 'call-1',
            output: 'found',
          }),
          functionCall('call-2', 'lookup'),
        ]);
      },
    });

    await harness.execute('first');
    while (requests.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await harness.execute('second', {
      deliveryMode: 'interrupt',
    });
    release();
    while (requests.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const response = await harness.getAgentResponse();
    expect(response.text).toBe('second answer');

    const restarted = requests[1];
    assert(restarted);
    const history = restarted.items.map((item) =>
      item.type === 'function_call_output'
        ? `${item.type}:${item.callId}`
        : ids([
            item,
          ])[0],
    );
    expect(history).toContain('fc-call-1');
    expect(history).toContain('function_call_output:call-1');
    // The unanswered call gets an output so the history stays valid.
    expect(history).toContain('function_call_output:call-2');
    expect(history.indexOf('fc-call-2')).toBeLessThan(history.length - 1);
  });
});

describe('MessageQueue.take', () => {
  it('removes matching messages, keeps the rest in order, and notifies once', () => {
    const queue = new MessageQueue();
    queue.enqueue(queued('a', 'next-turn', 'a'));
    queue.enqueue(queued('b', 'between-rounds', 'b'));
    queue.enqueue(queued('c', 'next-turn', 'c'));
    queue.enqueue(queued('d', 'next-item', 'd'));
    let notified = 0;
    queue.subscribe(() => {
      notified += 1;
    });

    const taken = queue.take((message) => message.deliveryMode !== 'next-turn');

    expect(taken.map((message) => message.id)).toEqual([
      'b',
      'd',
    ]);
    expect(queue.peekAll().map((message) => message.id)).toEqual([
      'a',
      'c',
    ]);
    expect(notified).toBe(1);
    expect(queue.take(() => false)).toEqual([]);
    expect(notified).toBe(1);
  });
});
