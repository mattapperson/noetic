import { describe, it, expect } from 'bun:test';
import { assembleView } from '../../src/memory/projector';
import type { Item, MessageItem } from '../../src/types/items';

function makeMessage(role: 'system' | 'developer' | 'user' | 'assistant', text: string): MessageItem {
  return { id: `msg-${text}`, status: 'completed', type: 'message', role, content: [{ type: 'input_text', text }] };
}

describe('assembleView', () => {
  it('concatenates system + layer + history', () => {
    const sys = [makeMessage('system', 'sys')];
    const layers = [makeMessage('developer', 'layer')];
    const history = [makeMessage('user', 'hello'), makeMessage('assistant', 'hi')];
    const view = assembleView(sys, layers, history);
    expect(view).toHaveLength(4);
    expect((view[0] as MessageItem).role).toBe('system');
    expect((view[1] as MessageItem).role).toBe('developer');
    expect((view[2] as MessageItem).role).toBe('user');
  });

  it('applies sliding_window policy', () => {
    const history = Array.from({ length: 10 }, (_, i) => makeMessage('user', `msg-${i}`));
    const view = assembleView([], [], history, { tokenBudget: 10000, responseReserve: 1000, overflow: 'sliding_window', windowSize: 3 });
    // system(0) + layers(0) + window(3)
    expect(view).toHaveLength(3);
    expect((view[0] as MessageItem).content[0]).toEqual({ type: 'input_text', text: 'msg-7' });
  });

  it('passes all history without policy', () => {
    const history = Array.from({ length: 5 }, (_, i) => makeMessage('user', `msg-${i}`));
    const view = assembleView([], [], history);
    expect(view).toHaveLength(5);
  });

  it('handles truncate overflow', () => {
    const history = Array.from({ length: 5 }, (_, i) => makeMessage('user', `msg-${i}`));
    const view = assembleView([], [], history, { tokenBudget: 10000, responseReserve: 1000, overflow: 'truncate' });
    expect(view).toHaveLength(5);
  });
});
