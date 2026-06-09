import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { assembleView } from '@noetic-tools/memory';
import { makeMessage } from '../_helpers';

describe('assembleView', () => {
  it('concatenates system + layer + history', () => {
    const sys = [
      makeMessage('system', 'sys'),
    ];
    const layers = [
      makeMessage('developer', 'layer'),
    ];
    const history = [
      makeMessage('user', 'hello'),
      makeMessage('assistant', 'hi'),
    ];
    const view = assembleView({
      systemPromptItems: sys,
      layerOutputItems: layers,
      historyItems: history,
    });
    expect(view).toHaveLength(4);
    assert(view[0].type === 'message');
    expect(view[0].role).toBe('system');
    assert(view[1].type === 'message');
    expect(view[1].role).toBe('developer');
    assert(view[2].type === 'message');
    expect(view[2].role).toBe('user');
  });

  it('applies sliding_window policy', () => {
    const history = Array.from(
      {
        length: 10,
      },
      (_, i) => makeMessage('user', `msg-${i}`),
    );
    const view = assembleView({
      systemPromptItems: [],
      layerOutputItems: [],
      historyItems: history,
      policy: {
        tokenBudget: 1e4,
        responseReserve: 1e3,
        overflow: 'sliding_window',
        windowSize: 3,
      },
    });
    // system(0) + layers(0) + window(3)
    expect(view).toHaveLength(3);
    assert(view[0].type === 'message');
    expect(view[0].content[0]).toEqual({
      type: 'input_text',
      text: 'msg-7',
    });
  });

  it('passes all history without policy', () => {
    const history = Array.from(
      {
        length: 5,
      },
      (_, i) => makeMessage('user', `msg-${i}`),
    );
    const view = assembleView({
      systemPromptItems: [],
      layerOutputItems: [],
      historyItems: history,
    });
    expect(view).toHaveLength(5);
  });

  it('windowSize: 0 is treated as unset, returning full history', () => {
    const history = Array.from(
      {
        length: 5,
      },
      (_, i) => makeMessage('user', `msg-${i}`),
    );
    const view = assembleView({
      systemPromptItems: [],
      layerOutputItems: [],
      historyItems: history,
      policy: {
        tokenBudget: 1e4,
        responseReserve: 1e3,
        overflow: 'sliding_window',
        windowSize: 0,
      },
    });
    // windowSize of 0 is treated as no window constraint; all items are returned
    expect(view).toHaveLength(5);
  });

  it('windowSize > history length returns all items', () => {
    const history = [
      makeMessage('user', 'only'),
    ];
    const view = assembleView({
      systemPromptItems: [],
      layerOutputItems: [],
      historyItems: history,
      policy: {
        tokenBudget: 1e4,
        responseReserve: 1e3,
        overflow: 'sliding_window',
        windowSize: 100,
      },
    });
    expect(view).toHaveLength(1);
  });

  it('all three input arrays empty returns empty array', () => {
    const view = assembleView({
      systemPromptItems: [],
      layerOutputItems: [],
      historyItems: [],
    });
    expect(view).toEqual([]);
  });

  it('handles truncate overflow', () => {
    const history = Array.from(
      {
        length: 5,
      },
      (_, i) => makeMessage('user', `msg-${i}`),
    );
    const view = assembleView({
      systemPromptItems: [],
      layerOutputItems: [],
      historyItems: history,
      policy: {
        tokenBudget: 1e4,
        responseReserve: 1e3,
        overflow: 'truncate',
      },
    });
    expect(view).toHaveLength(5);
  });

  it('keeps capped history items after layerOutputItems', () => {
    const layers = [
      makeMessage('developer', 'recall-a'),
      makeMessage('developer', 'recall-b'),
    ];
    const history = Array.from(
      {
        length: 10,
      },
      (_, i) => makeMessage('user', `h-${i}`),
    );
    const view = assembleView({
      systemPromptItems: [],
      layerOutputItems: layers,
      historyItems: history,
      policy: {
        tokenBudget: 1e4,
        responseReserve: 1e3,
        overflow: 'sliding_window',
        windowSize: 2,
      },
    });
    // 2 layer items + 2 capped history items
    expect(view).toHaveLength(4);
    assert(view[0].type === 'message');
    expect(view[0].role).toBe('developer');
    assert(view[1].type === 'message');
    expect(view[1].role).toBe('developer');
    assert(view[2].type === 'message');
    expect(view[2].role).toBe('user');
    assert(view[2].content[0].type === 'input_text');
    expect(view[2].content[0].text).toBe('h-8');
    assert(view[3].type === 'message');
    assert(view[3].content[0].type === 'input_text');
    expect(view[3].content[0].text).toBe('h-9');
  });
});
