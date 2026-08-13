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
    bridge: new AcpEventBridge(step, 'claude-code', withBroadcaster),
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
  ])('surfaces the %s update on the full stream under its protocol name', (name, update) => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward(
      frameworkCast<AcpSessionNotification>({
        sessionId: 's1',
        update,
      }),
    );

    expect(types(events)).toContain(`acp.${name}`);
  });

  it('emits every notification as a raw acp_event framework event', () => {
    const { bridge, events } = bridgeCtx(STEP);

    bridge.begin();
    bridge.forward(textChunk('hello'));

    // Framework events are namespaced by agent name: `<agent>:<eventType>`.
    const acpEvent = events.find((e) => e.source === 'framework' && e.type.endsWith(':acp_event'));
    assert(acpEvent);
    expect(acpEvent.data.stepId).toBe('review');
    expect(acpEvent.data.agentId).toBe('claude-code');
    expect(acpEvent.data.sessionId).toBe('s1');
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
