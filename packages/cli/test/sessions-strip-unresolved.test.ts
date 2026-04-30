import { describe, expect, it } from 'bun:test';
import type {
  FunctionCallItem,
  FunctionCallOutputItem,
  InputMessageItem,
  Item,
} from '@noetic/core';

import { stripUnresolvedToolCalls } from '../src/sessions/strip-unresolved.js';

function userMsg(id: string, text: string): InputMessageItem {
  return {
    id,
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [
      {
        type: 'input_text',
        text,
      },
    ],
  };
}

function functionCall(callId: string, name = 'foo'): FunctionCallItem {
  return {
    id: `fc-${callId}`,
    type: 'function_call',
    status: 'completed',
    callId,
    name,
    arguments: '{}',
  };
}

function functionCallOutput(callId: string, output = 'ok'): FunctionCallOutputItem {
  return {
    id: `out-${callId}`,
    type: 'function_call_output',
    status: 'completed',
    callId,
    output,
  };
}

describe('stripUnresolvedToolCalls', () => {
  it('keeps paired function_call + function_call_output', () => {
    const items: Item[] = [
      userMsg('u1', 'do the thing'),
      functionCall('c1'),
      functionCallOutput('c1'),
    ];
    expect(stripUnresolvedToolCalls(items)).toHaveLength(3);
  });

  it('drops a function_call with no matching output', () => {
    const items: Item[] = [
      userMsg('u1', 'hi'),
      functionCall('c1'),
    ];
    const out = stripUnresolvedToolCalls(items);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('message');
  });

  it('drops an orphan function_call_output with no matching call', () => {
    const items: Item[] = [
      userMsg('u1', 'hi'),
      functionCallOutput('c1'),
    ];
    const out = stripUnresolvedToolCalls(items);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('message');
  });

  it('preserves non-tool items untouched', () => {
    const items: Item[] = [
      userMsg('u1', 'first'),
      userMsg('u2', 'second'),
    ];
    const out = stripUnresolvedToolCalls(items);
    expect(out).toHaveLength(2);
  });

  it('handles a mix of resolved and unresolved calls', () => {
    const items: Item[] = [
      functionCall('a'),
      functionCallOutput('a'),
      functionCall('b'),
      functionCallOutput('orphan'),
    ];
    const out = stripUnresolvedToolCalls(items);
    expect(out).toHaveLength(2);
    expect(out.every((i) => i.type === 'function_call' || i.type === 'function_call_output')).toBe(
      true,
    );
    const ids = out
      .filter(
        (i): i is FunctionCallItem | FunctionCallOutputItem =>
          i.type === 'function_call' || i.type === 'function_call_output',
      )
      .map((i) => i.callId);
    expect(ids.sort()).toEqual([
      'a',
      'a',
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(stripUnresolvedToolCalls([])).toEqual([]);
  });
});
