/**
 * Direct tests of the turn pump: boundary flushing, output content on
 * completions, errorKind-based stop reasons, and nested-update validation +
 * id namespacing.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StreamEvent } from '@noetic-tools/types';
import type { ServeSessionUpdate } from '../src/serve-events';
import { pumpTurnEvents } from '../src/serve-events';

function fw(name: string, data: Record<string, unknown>): StreamEvent {
  return {
    source: 'framework',
    type: `agent:${name}`,
    data,
  };
}

function sdk(type: string, data: Record<string, unknown>): StreamEvent {
  return {
    source: 'sdk',
    type,
    data,
  };
}

async function* replay(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  yield* events;
}

async function pump(events: StreamEvent[]): Promise<{
  outcome: Awaited<ReturnType<typeof pumpTurnEvents>>;
  updates: ServeSessionUpdate[];
}> {
  const updates: ServeSessionUpdate[] = [];
  const outcome = await pumpTurnEvents({
    events: replay(events),
    messageId: 'm1',
    notify: async (update) => {
      updates.push(update);
    },
    present: (toolName) => ({
      title: toolName,
      status: 'in_progress',
    }),
    cancelRequested: () => false,
  });
  return {
    outcome,
    updates,
  };
}

const START = fw('turn_started', {
  turnId: 't1',
  messageIds: [
    'm1',
  ],
});

describe('pumpTurnEvents', () => {
  it("never sends a nested agent's output to the editor as the session's", async () => {
    const scope = {
      id: 'step/agent:child',
    };
    const { updates } = await pump([
      START,
      {
        ...sdk('response.output_text.delta', {
          delta: 'worker draft',
        }),
        scope,
      },
      {
        ...sdk('response.reasoning.delta', {
          delta: 'worker thinks',
        }),
        scope,
      },
      sdk('response.output_text.delta', {
        delta: 'the answer',
      }),
      fw('turn_completed', {
        turnId: 't1',
      }),
    ]);
    const text = JSON.stringify(updates);
    expect(text).toContain('the answer');
    expect(text).not.toContain('worker');
  });

  it('flushes open tool calls as failed when the turn aborts', async () => {
    const { outcome, updates } = await pump([
      START,
      fw('tool_call_started', {
        name: 'bash',
        callId: 'c1',
      }),
      fw('turn_aborted', {
        turnId: 't1',
        reason: 'cancelled',
        errorKind: 'cancelled',
      }),
    ]);

    expect(outcome).toEqual({
      kind: 'stop',
      stopReason: 'cancelled',
    });
    const flushed = updates.find((u) => u.sessionUpdate === 'tool_call_update');
    assert(flushed && flushed.sessionUpdate === 'tool_call_update');
    expect(flushed.toolCallId).toBe('c1');
    expect(flushed.status).toBe('failed');
  });

  it('flushes open tool calls as completed at a normal turn boundary', async () => {
    const { updates } = await pump([
      START,
      fw('tool_call_started', {
        name: 'bash',
        callId: 'c1',
      }),
      fw('turn_completed', {
        turnId: 't1',
        durationMs: 1,
      }),
    ]);
    const flushed = updates.find((u) => u.sessionUpdate === 'tool_call_update');
    assert(flushed && flushed.sessionUpdate === 'tool_call_update');
    expect(flushed.status).toBe('completed');
  });

  it('carries the tool output as renderable content on completion', async () => {
    const { updates } = await pump([
      START,
      fw('tool_call_started', {
        name: 'add',
        callId: 'c1',
      }),
      fw('tool_call_completed', {
        name: 'add',
        callId: 'c1',
        error: false,
        output: '{"sum":5}',
      }),
      fw('turn_completed', {
        turnId: 't1',
        durationMs: 1,
      }),
    ]);
    const completed = updates.find((u) => u.sessionUpdate === 'tool_call_update');
    assert(completed && completed.sessionUpdate === 'tool_call_update');
    expect(completed.status).toBe('completed');
    const content = completed.content?.[0];
    assert(content && content.type === 'content' && content.content.type === 'text');
    expect(content.content.text).toBe('{"sum":5}');
    // The flush at the boundary must not re-close an already-completed call.
    const updatesForCall = updates.filter((u) => u.sessionUpdate === 'tool_call_update');
    expect(updatesForCall).toHaveLength(1);
  });

  it('a failed tool call carries the failure text and status failed', async () => {
    const { updates } = await pump([
      START,
      fw('tool_call_completed', {
        name: 'deploy',
        callId: 'c1',
        error: true,
        output: 'Tool call denied: not today',
      }),
      fw('turn_completed', {
        turnId: 't1',
        durationMs: 1,
      }),
    ]);
    const failed = updates.find((u) => u.sessionUpdate === 'tool_call_update');
    assert(failed && failed.sessionUpdate === 'tool_call_update');
    expect(failed.status).toBe('failed');
    const content = failed.content?.[0];
    assert(content && content.type === 'content' && content.content.type === 'text');
    expect(content.content.text).toContain('not today');
  });

  it('maps errorKind model_refused to the refusal stop reason', async () => {
    const { outcome } = await pump([
      START,
      fw('turn_aborted', {
        turnId: 't1',
        reason: "Model refused at step 'x': no",
        errorKind: 'model_refused',
      }),
    ]);
    expect(outcome).toEqual({
      kind: 'stop',
      stopReason: 'refusal',
    });
  });

  it('an abort without a recognized kind is an error outcome', async () => {
    const { outcome } = await pump([
      START,
      fw('turn_aborted', {
        turnId: 't1',
        reason: 'exploded',
        errorKind: 'step_failed',
      }),
    ]);
    assert(outcome.kind === 'error');
    expect(outcome.message).toBe('exploded');
  });

  it("forwards a delegated agent's tool calls as any tool call, from the generic events", async () => {
    const { updates } = await pump([
      START,
      fw('tool_call_started', {
        name: 'Edit',
        callId: 'nested-1',
      }),
      fw('tool_call_completed', {
        name: 'Edit',
        callId: 'nested-1',
        error: false,
      }),
      fw('turn_completed', {
        turnId: 't1',
        durationMs: 1,
      }),
    ]);

    expect(
      updates
        .filter((u) => u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')
        .map((u) => [
          u.sessionUpdate,
          'toolCallId' in u ? u.toolCallId : undefined,
        ]),
    ).toEqual([
      [
        'tool_call',
        'nested-1',
      ],
      [
        'tool_call_update',
        'nested-1',
      ],
    ]);
  });
});

describe('capped turns', () => {
  it('ends a turn whose last step stopped at a cap with that cap, whatever its events showed', async () => {
    const { outcome } = await pump([
      START,
      fw('turn_completed', {
        turnId: 't1',
        durationMs: 1,
        stopReason: 'max_turn_requests',
      }),
    ]);
    expect(outcome).toEqual({
      kind: 'stop',
      stopReason: 'max_turn_requests',
    });
  });

  it('a turn whose last step answered in full ends end_turn', async () => {
    const { outcome } = await pump([
      START,
      fw('turn_completed', {
        turnId: 't1',
        durationMs: 1,
        stopReason: 'end_turn',
      }),
    ]);
    expect(outcome).toEqual({
      kind: 'stop',
      stopReason: 'end_turn',
    });
  });
});

describe('budget stops', () => {
  it('maps errorKind budget_exceeded to the max_tokens stop reason', async () => {
    const { outcome } = await pump([
      START,
      fw('turn_aborted', {
        turnId: 't1',
        reason: 'token budget exhausted',
        errorKind: 'budget_exceeded',
      }),
    ]);
    expect(outcome).toEqual({
      kind: 'stop',
      stopReason: 'max_tokens',
    });
  });
});

describe('turn claiming', () => {
  it('a non-primary coalesced claim stays silent and resolves at the boundary', async () => {
    const updates: ServeSessionUpdate[] = [];
    const outcome = await pumpTurnEvents({
      events: replay([
        fw('turn_started', {
          turnId: 't1',
          messageIds: [
            'other',
            'm1',
          ],
        }),
        sdk('response.output_text.delta', {
          delta: 'shared reply',
        }),
        fw('turn_completed', {
          turnId: 't1',
          durationMs: 1,
        }),
      ]),
      messageId: 'm1',
      notify: async (update) => {
        updates.push(update);
      },
      present: (toolName) => ({
        title: toolName,
        status: 'in_progress',
      }),
      cancelRequested: () => false,
    });

    expect(outcome).toEqual({
      kind: 'stop',
      stopReason: 'end_turn',
    });
    // The FIRST id's pump owns the notifications; this one sent nothing.
    expect(updates).toHaveLength(0);
  });

  it('an inbox_injected claim ends at the next boundary whatever its turnId', async () => {
    const { outcome, updates } = await pump([
      fw('inbox_injected', {
        messageIds: [
          'm1',
        ],
      }),
      sdk('response.output_text.delta', {
        delta: 'mid-turn',
      }),
      fw('turn_completed', {
        turnId: 'someone-elses-turn',
        durationMs: 1,
      }),
    ]);
    expect(outcome).toEqual({
      kind: 'stop',
      stopReason: 'end_turn',
    });
    expect(updates.some((u) => u.sessionUpdate === 'agent_message_chunk')).toBe(true);
  });

  it('ignores a foreign turn boundary and ends at its own', async () => {
    const { outcome } = await pump([
      START,
      fw('turn_completed', {
        turnId: 'other-turn',
        durationMs: 1,
      }),
      fw('turn_completed', {
        turnId: 't1',
        durationMs: 1,
      }),
    ]);
    expect(outcome).toEqual({
      kind: 'stop',
      stopReason: 'end_turn',
    });
  });

  it('a stream that ends without a boundary resolves cancelled', async () => {
    const { outcome } = await pump([
      START,
      sdk('response.output_text.delta', {
        delta: 'cut off',
      }),
    ]);
    expect(outcome).toEqual({
      kind: 'stop',
      stopReason: 'cancelled',
    });
  });
});

describe('remaining translation rows', () => {
  it('reasoning deltas become agent_thought_chunk', async () => {
    const { updates } = await pump([
      START,
      sdk('response.reasoning.delta', {
        delta: 'thinking…',
      }),
      fw('turn_completed', {
        turnId: 't1',
        durationMs: 1,
      }),
    ]);
    const thought = updates.find((u) => u.sessionUpdate === 'agent_thought_chunk');
    assert(thought && thought.sessionUpdate === 'agent_thought_chunk');
    assert(thought.content.type === 'text');
    expect(thought.content.text).toBe('thinking…');
  });

  it('malformed function-call argument JSON still reports the call, without rawInput', async () => {
    const { updates } = await pump([
      START,
      sdk('response.output_item.done', {
        item: {
          type: 'function_call',
          callId: 'c1',
          name: 'add',
          arguments: '{not json',
        },
      }),
      fw('tool_call_started', {
        name: 'add',
        callId: 'c1',
      }),
      fw('turn_completed', {
        turnId: 't1',
        durationMs: 1,
      }),
    ]);
    const call = updates.find((u) => u.sessionUpdate === 'tool_call');
    assert(call && call.sessionUpdate === 'tool_call');
    expect(call.toolCallId).toBe('c1');
    expect(call.rawInput).toBeUndefined();
  });
});
