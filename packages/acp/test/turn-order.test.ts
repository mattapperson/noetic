import { describe, expect, it } from 'bun:test';
import type { AcpSessionNotification } from '@noetic-tools/types';
import { AcpTurnAccumulator } from '../src/turn';

function text(chunk: string): AcpSessionNotification {
  return {
    sessionId: 's',
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: chunk,
      },
    },
  };
}

function call(toolCallId: string): AcpSessionNotification {
  return {
    sessionId: 's',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'Read file',
      status: 'completed',
    },
  };
}

describe('AcpTurnAccumulator item order', () => {
  it('interleaves messages and tool calls as the agent produced them', () => {
    const turn = new AcpTurnAccumulator();
    for (const notification of [
      text('Let me look. '),
      text('Reading now.'),
      call('t1'),
      text('Found it.'),
      call('t2'),
      text('All done.'),
    ]) {
      turn.push(notification);
    }
    const result = turn.result({
      stopReason: 'end_turn',
    });
    expect(
      result.items.map((item) =>
        item.type === 'message'
          ? `msg:${item.content.map((part) => ('text' in part ? part.text : '')).join('')}`
          : item.type === 'function_call'
            ? `call:${item.callId}`
            : 'out',
      ),
    ).toEqual([
      'msg:Let me look. Reading now.',
      'call:t1',
      'out',
      'msg:Found it.',
      'call:t2',
      'out',
      'msg:All done.',
    ]);
    expect(result.text).toBe('All done.');
  });

  it('returns no final text when the turn ends on a tool call', () => {
    const turn = new AcpTurnAccumulator();
    turn.push(text('Calling.'));
    turn.push(call('t1'));
    expect(
      turn.result({
        stopReason: 'end_turn',
      }).text,
    ).toBe('');
  });
});
