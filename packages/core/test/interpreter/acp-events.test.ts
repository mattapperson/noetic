/**
 * Tests for the ACP → harness event bridge: every `session/update` variant is
 * mapped onto the observable event surface, and a turn always emits its output
 * even when the agent streamed nothing.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type {
  AcpSessionNotification,
  AcpTurnResult,
  Context,
  ContextData,
  StepAcpAgent,
} from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { AgentHarness } from '../../src/harness/agent-harness';
import { AcpEventBridge } from '../../src/interpreter/acp-events';

//#region Helpers

interface CapturedEvent {
  source: string;
  type: string;
  data: Record<string, unknown>;
  outputIndex?: number;
}

/**
 * A context whose broadcaster records every event. Built by hand rather than
 * through a live run so a single notification's mapping can be asserted in
 * isolation.
 */
function bridgeCtx(step: Pick<StepAcpAgent, 'id' | 'emit'>): {
  bridge: AcpEventBridge;
  events: CapturedEvent[];
} {
  const events: CapturedEvent[] = [];
  const harness = new AgentHarness({
    name: 'test',
    params: {},
  });
  const ctx = harness.createContext();
  const broadcaster = {
    emit(event: CapturedEvent) {
      events.push(event);
    },
  };
  // `getBroadcaster` walks the context chain looking for `_broadcaster`;
  // injecting one keeps the test focused on the mapping itself.
  const withBroadcaster = frameworkCast<
    Context<ContextData> & {
      _broadcaster: unknown;
    }
  >(ctx);
  withBroadcaster._broadcaster = broadcaster;

  return {
    bridge: new AcpEventBridge(step, withBroadcaster),
    events,
  };
}

function types(events: CapturedEvent[]): string[] {
  return events.map((e) => e.type);
}

function textChunk(text: string): AcpSessionNotification {
  return {
    sessionId: 's1',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text,
      },
    },
  };
}

function emptyResult(overrides: Partial<AcpTurnResult> = {}): AcpTurnResult {
  return {
    stopReason: 'end_turn',
    items: [],
    text: '',
    ...overrides,
  };
}

const STEP = {
  id: 'review',
} satisfies Pick<StepAcpAgent, 'id' | 'emit'>;

//#endregion

describe('AcpEventBridge', () => {
  it('brackets a turn with response.created and response.completed', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.finalize(emptyResult());

    expect(types(events)).toContain('response.created');
    expect(types(events)).toContain('response.completed');
  });

  it('maps an agent_message_chunk to an output item plus a text delta', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward(textChunk('hello'));

    const sdk = types(events);
    expect(sdk).toContain('response.output_item.added');
    expect(sdk).toContain('response.output_text.delta');
    const delta = events.find((e) => e.type === 'response.output_text.delta');
    expect(delta?.data.delta).toBe('hello');
  });

  it('opens the assistant message only once across several chunks', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward(textChunk('a'));
    bridge.forward(textChunk('b'));
    bridge.forward(textChunk('c'));

    const added = events.filter((e) => e.type === 'response.output_item.added');
    const deltas = events.filter((e) => e.type === 'response.output_text.delta');
    expect(added).toHaveLength(1);
    expect(deltas).toHaveLength(3);
  });

  it('maps an agent_thought_chunk to a reasoning delta', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: {
          type: 'text',
          text: 'thinking',
        },
      },
    });

    const reasoning = events.find((e) => e.type === 'response.reasoning.delta');
    expect(reasoning?.data.delta).toBe('thinking');
  });

  it('maps a tool_call to a function_call item with its arguments', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Read config.json',
        kind: 'read',
        rawInput: {
          path: '/a.json',
        },
      },
    });

    const sdk = types(events);
    expect(sdk).toContain('response.function_call_arguments.delta');
    expect(sdk).toContain('response.function_call_arguments.done');
    const done = events.find((e) => e.type === 'response.function_call_arguments.done');
    expect(JSON.parse(String(done?.data.arguments))).toEqual({
      path: '/a.json',
    });
  });

  it.each([
    [
      'plan',
      {
        sessionUpdate: 'plan' as const,
        entries: [],
      },
    ],
    [
      'available_commands_update',
      {
        sessionUpdate: 'available_commands_update' as const,
        availableCommands: [],
      },
    ],
    [
      'current_mode_update',
      {
        sessionUpdate: 'current_mode_update' as const,
        currentModeId: 'plan',
      },
    ],
  ])('emits nothing for the %s update: session state, not output', (_name, update) => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward(
      frameworkCast<AcpSessionNotification>({
        sessionId: 's1',
        update,
      }),
    );

    expect(types(events)).toEqual([
      'response.created',
    ]);
  });

  it('never names the protocol on the stream', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward(textChunk('hello'));
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'Read',
        status: 'completed',
      },
    });

    expect(types(events).filter((type) => /acp/.test(type))).toEqual([]);
  });

  it("reports the agent's own tool calls as the callModel tool loop does, after their call item", () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'Read',
      },
    });
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'in_progress',
      },
    });
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'failed',
      },
    });
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c1',
        status: 'failed',
      },
    });

    const order = types(events).filter(
      (type) => type === 'response.output_item.done' || /tool_call_(started|completed)$/.test(type),
    );
    expect(order).toEqual([
      'response.output_item.done',
      'test:tool_call_started',
      'test:tool_call_completed',
    ]);
    const completed = events.find((e) => e.type.endsWith(':tool_call_completed'));
    expect(completed?.data).toMatchObject({
      name: 'Read',
      callId: 'c1',
      error: true,
    });
  });

  it('ends a call item with the call, and completes a call with its output', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c3',
        title: 'Read',
        rawInput: {
          path: '/a',
        },
      },
    });
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'c3',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: {
              type: 'text',
              text: 'file body',
            },
          },
        ],
      },
    });

    const done = events.find((e) => e.type === 'response.output_item.done');
    expect(done?.data.item).toMatchObject({
      type: 'function_call',
      callId: 'c3',
      name: 'Read',
      arguments: '{"path":"/a"}',
    });
    const completed = events.find((e) => e.type.endsWith(':tool_call_completed'));
    // The payload the `callModel` tool loop emits: no step, no adapter.
    expect(completed?.data).toEqual({
      name: 'Read',
      callId: 'c3',
      error: false,
      output: 'file body',
    });
  });

  it.each([
    'finalize',
    'abort',
  ] as const)('settles a call still open when the turn ends (%s), failed', (end) => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c4',
        title: 'Bash',
      },
    });
    if (end === 'finalize') {
      bridge.finalize(emptyResult());
    } else {
      bridge.abort(new Error('gone'));
    }

    const completed = events.filter((e) => e.type.endsWith(':tool_call_completed'));
    expect(
      completed.map((e) => [
        e.data.callId,
        e.data.error,
      ]),
    ).toEqual([
      [
        'c4',
        true,
      ],
    ]);
    const settledAt = events.indexOf(completed[0] ?? events[0]);
    const closedAt = events.findIndex((e) => e.type === 'response.completed');
    expect(settledAt).toBeLessThan(closedAt);
  });

  it('gives a call the agent reported only in its result its whole lifecycle', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.finalize(
      emptyResult({
        items: [
          {
            id: 'c5',
            type: 'function_call',
            status: 'completed',
            callId: 'c5',
            name: 'Grep',
            arguments: '{}',
          },
          {
            id: 'o5',
            type: 'function_call_output',
            status: 'completed',
            callId: 'c5',
            output: 'matches',
          },
        ],
      }),
    );

    const lifecycle = events.filter((e) => /tool_call_(started|completed)$/.test(e.type));
    expect(
      lifecycle.map((e) => [
        e.type.split(':')[1],
        e.data.output,
      ]),
    ).toEqual([
      [
        'tool_call_started',
        undefined,
      ],
      [
        'tool_call_completed',
        'matches',
      ],
    ]);
  });

  it('reports a bridged call once, under the id the bridge runs it under, whatever id it was announced under', () => {
    const { bridge, events } = bridgeCtx(STEP);
    bridge.nameToolCalls((title) => (title === 'mcp__noetic__echo' ? 'echo' : undefined));

    bridge.begin();
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'announced-x',
        title: 'mcp__noetic__echo',
        rawInput: {
          text: 'hi',
        },
      },
    });
    bridge.bridgedCallStarted('ran-y', 'echo', {
      text: 'hi',
    });
    bridge.bridgedCallCompleted('ran-y', {
      name: 'echo',
      error: false,
      output: 'hi',
    });
    bridge.finalize(emptyResult());

    const calls = events.filter(
      (e) =>
        /tool_call_(started|completed)$/.test(e.type) ||
        (e.type === 'response.output_item.done' && e.data.item !== undefined),
    );
    expect(
      calls.map((e) => [
        e.type.replace(/^.*:/, ''),
        e.type === 'response.output_item.done'
          ? JSON.stringify(e.data.item).includes('ran-y')
          : e.data.callId,
      ]),
    ).toEqual([
      [
        'response.output_item.done',
        true,
      ],
      [
        'tool_call_started',
        'ran-y',
      ],
      [
        'tool_call_completed',
        'ran-y',
      ],
    ]);
    expect(JSON.stringify(events)).not.toContain('announced-x');
  });

  it('reports a call announced to a bridged tool that never reached it as failed', () => {
    const { bridge, events } = bridgeCtx(STEP);
    bridge.nameToolCalls((title) => (title === 'mcp__noetic__echo' ? 'echo' : undefined));

    bridge.begin();
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'lost',
        title: 'mcp__noetic__echo',
      },
    });
    bridge.finalize(emptyResult());

    const lifecycle = events.filter((e) => /tool_call_(started|completed)$/.test(e.type));
    expect(
      lifecycle.map((e) => [
        e.type.replace(/^.*:/, ''),
        e.data.callId,
        e.data.error,
      ]),
    ).toEqual([
      [
        'tool_call_started',
        'lost',
        undefined,
      ],
      [
        'tool_call_completed',
        'lost',
        true,
      ],
    ]);
    const settledAt = events.indexOf(lifecycle[1] ?? events[0]);
    const closedAt = events.findIndex((e) => e.type === 'response.completed');
    expect(settledAt).toBeLessThan(closedAt);
  });

  it('reports a bridged call the agent never announced, with its arguments before its start', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.bridgedCallStarted('quiet', 'echo', {
      text: 'x',
    });

    const done = events.findIndex(
      (e) =>
        e.type === 'response.output_item.done' &&
        JSON.stringify(e.data.item).includes('"text\\":\\"x'),
    );
    const started = events.findIndex((e) => e.type.endsWith(':tool_call_started'));
    expect(done).toBeGreaterThanOrEqual(0);
    expect(done).toBeLessThan(started);
  });

  it('pairs a call run under another id by its input, and reports only the one that never ran', () => {
    const { bridge, events } = bridgeCtx(STEP);
    bridge.nameToolCalls((title) => (title === 'mcp__noetic__echo' ? 'echo' : undefined));
    const announce = (id: string, value: string): void =>
      bridge.forward({
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: id,
          title: 'mcp__noetic__echo',
          rawInput: {
            value,
          },
        },
      });

    bridge.begin();
    announce('skipped', 'skipped');
    announce('real', 'ran');
    bridge.bridgedCallStarted('runner-id', 'echo', {
      value: 'ran',
    });
    bridge.bridgedCallCompleted('runner-id', {
      name: 'echo',
      error: false,
    });
    bridge.finalize(emptyResult());

    const completed = events.filter((e) => e.type.endsWith(':tool_call_completed'));
    expect(
      completed.map((e) => [
        e.data.callId,
        e.data.error,
      ]),
    ).toEqual([
      [
        'runner-id',
        false,
      ],
      [
        'skipped',
        true,
      ],
    ]);
  });

  it('reports no call failed on a guess when fewer runs than announcements cannot be paired', () => {
    const { bridge, events } = bridgeCtx(STEP);
    bridge.nameToolCalls((title) => (title === 'mcp__noetic__echo' ? 'echo' : undefined));

    bridge.begin();
    for (const id of [
      'a',
      'b',
    ]) {
      bridge.forward({
        sessionId: 's1',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: id,
          title: 'mcp__noetic__echo',
        },
      });
    }
    bridge.bridgedCallStarted('runner-id', 'echo', {
      value: 'unrelated',
    });
    bridge.bridgedCallCompleted('runner-id', {
      name: 'echo',
      error: false,
    });
    bridge.finalize(emptyResult());

    const completed = events.filter((e) => e.type.endsWith(':tool_call_completed'));
    expect(completed.map((e) => e.data.callId)).toEqual([
      'runner-id',
    ]);
  });

  it('settles a bridged call whose pipeline threw before the turn closes', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.bridgedCallStarted('thrown', 'echo', {});
    bridge.abort(new Error('steering hook threw'));

    const completed = events.findIndex(
      (e) => e.type.endsWith(':tool_call_completed') && e.data.callId === 'thrown',
    );
    const closed = events.findIndex((e) => e.type === 'response.completed');
    expect(completed).toBeGreaterThanOrEqual(0);
    expect(completed).toBeLessThan(closed);
    expect(events[completed]?.data.error).toBe(true);
  });

  it('completes a result-only call as its result recorded it', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.finalize(
      emptyResult({
        items: [
          {
            id: 'f1',
            type: 'function_call',
            status: 'completed',
            callId: 'f1',
            name: 'Bash',
            arguments: '{}',
          },
          {
            id: 'o1',
            type: 'function_call_output',
            status: 'failed',
            callId: 'f1',
            output: 'exit 1',
          },
          {
            id: 'f2',
            type: 'function_call',
            status: 'completed',
            callId: 'f2',
            name: 'Read',
            arguments: '{}',
          },
        ],
      }),
    );

    const completed = events.filter((e) => e.type.endsWith(':tool_call_completed'));
    expect(
      completed.map((e) => [
        e.data.callId,
        e.data.error,
      ]),
    ).toEqual([
      [
        'f1',
        true,
      ],
      [
        'f2',
        true,
      ],
    ]);
  });

  it('ends its message with the whole message, as a model stream does', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward(textChunk('hel'));
    bridge.forward(textChunk('lo'));
    bridge.finalize(emptyResult());

    const done = events.find(
      (e) => e.type === 'response.output_item.done' && JSON.stringify(e.data).includes('message'),
    );
    expect(done?.data.item).toMatchObject({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'hello',
        },
      ],
    });
  });

  it("leaves a call to one of the step's bridged tools to the bridge", () => {
    const { bridge, events } = bridgeCtx(STEP);
    bridge.nameToolCalls((title) => (title === 'mcp__noetic__echo' ? 'echo' : undefined));

    bridge.begin();
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'c2',
        title: 'mcp__noetic__echo',
        status: 'completed',
      },
    });

    expect(types(events).filter((type) => /tool_call_(started|completed)$/.test(type))).toEqual([]);
  });

  it('synthesizes text events when the agent streamed nothing', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.finalize(
      emptyResult({
        text: 'result-only',
      }),
    );

    const delta = events.find((e) => e.type === 'response.output_text.delta');
    expect(delta?.data.delta).toBe('result-only');
  });

  it('does not re-announce a tool call already seen on the stream', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: 'Read',
        kind: 'read',
      },
    });
    bridge.finalize(
      emptyResult({
        items: [
          frameworkCast({
            id: 'call-1',
            type: 'function_call',
            status: 'completed',
            name: 'Read',
            callId: 'call-1',
            arguments: '{}',
          }),
        ],
      }),
    );

    const added = events.filter(
      (e) =>
        e.type === 'response.output_item.added' &&
        JSON.stringify(e.data).includes('"type":"function_call"'),
    );
    expect(added).toHaveLength(1);
  });

  it('carries the stop reason on response.completed', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.finalize(
      emptyResult({
        stopReason: 'max_tokens',
      }),
    );

    const completed = events.find((e) => e.type === 'response.completed');
    assert(completed);
    expect(completed.data.stopReason).toBe('max_tokens');
  });

  // Regression: `finalize` ran only on the success path, so a turn that threw
  // left `response.created` open with no completion — a consumer driving a UI
  // off `getFullStream()` waited forever on a response that never finished.
  it('closes the bracket with an error reason when the turn throws', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward(textChunk('partial'));
    bridge.abort(new Error('agent died mid-turn'));

    const completed = events.find((e) => e.type === 'response.completed');
    assert(completed);
    expect(completed.data.stopReason).toBe('error');
    expect(String(completed.data.error)).toContain('agent died mid-turn');
    // The open message is closed too, not left dangling.
    expect(events.filter((e) => e.type === 'response.output_item.added')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'response.output_item.done')).toHaveLength(1);
  });

  it('aborting after a clean finalize does not double-complete', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.finalize(emptyResult());
    bridge.abort(new Error('too late'));

    expect(events.filter((e) => e.type === 'response.completed')).toHaveLength(1);
  });

  it('output items finish in index order', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward(textChunk('hello'));
    // A tool call known only from the result, synthesized during finalize.
    bridge.finalize(
      emptyResult({
        text: 'hello',
        items: [
          frameworkCast({
            id: 'call-1',
            type: 'function_call',
            status: 'completed',
            name: 'Read',
            callId: 'call-1',
            arguments: '{}',
          }),
        ],
      }),
    );

    // The message (index 0) must close before the tool call (index 1) opens;
    // emitting them the other way round reads as interleaved output.
    const order = events
      .filter(
        (e) => e.type === 'response.output_item.done' || e.type === 'response.output_item.added',
      )
      .map((e) => `${e.type}@${e.outputIndex}`);
    expect(order).toEqual([
      'response.output_item.added@0',
      'response.output_item.done@0',
      'response.output_item.added@1',
      'response.output_item.done@1',
    ]);
  });

  it('emit: false suppresses every event', () => {
    const { bridge, events } = bridgeCtx({
      id: 'quiet',
      emit: false,
    });

    bridge.begin();
    bridge.forward(textChunk('hello'));
    bridge.finalize(
      emptyResult({
        text: 'hello',
      }),
    );

    expect(events).toHaveLength(0);
  });
});

describe('AcpEventBridge — current updates and replay', () => {
  it('emits nothing for usage_update: context occupancy is not output or billed usage (#96)', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward({
      sessionId: 's1',
      update: {
        sessionUpdate: 'usage_update',
        used: 22001,
        size: 258400,
      },
    });

    expect(types(events)).toEqual([
      'response.created',
    ]);
  });

  it('closes the turn with only its stop reason, whatever usage the agent reported', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.finalize(
      emptyResult({
        reportedUsage: {
          inputTokens: 3,
          outputTokens: 4,
          totalTokens: 7,
        },
      }),
    );

    const completed = events.find((e) => e.type === 'response.completed');
    assert(completed);
    expect(completed.data).toEqual({
      stopReason: 'end_turn',
    });
  });

  it('keeps a JSON-RPC error readable when the turn aborts (#96)', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.abort({
      code: -32000,
      message: 'Authentication required',
    });

    const completed = events.find((e) => e.type === 'response.completed');
    assert(completed);
    expect(completed.data.error).toBe('Authentication required (-32000)');
  });
});
