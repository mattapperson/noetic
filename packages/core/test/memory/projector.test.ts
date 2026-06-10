import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { assembleView } from '@noetic-tools/memory';
import type { Item } from '@noetic-tools/types';
import { estimateTokens } from '@noetic-tools/types';
import { makeMessage } from '../_helpers';

/** Serialized token cost — mirrors the projector's conservative estimate. */
function itemCost(item: Item): number {
  return estimateTokens(JSON.stringify(item));
}

/** Extract the text of every message item in the view (for order assertions). */
function viewTexts(view: Item[]): string[] {
  const texts: string[] = [];
  for (const item of view) {
    assert(item.type === 'message');
    const part = item.content[0];
    assert('text' in part && typeof part.text === 'string');
    texts.push(part.text.slice(0, 12));
  }
  return texts;
}

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

  describe('layer-output budget drops non-fitting items individually (M3)', () => {
    function policyFor(layerBudget: number) {
      return {
        tokenBudget: layerBudget,
        responseReserve: 0,
        overflow: 'sliding_window' as const,
      };
    }

    it('an oversized low-slot item does not evict a fitting higher-slot item (verifier repro)', () => {
      const oversized = makeMessage('developer', 'BIG '.repeat(1_237)); // ≫ 1000 tokens
      const small = makeMessage('developer', `small ${'y'.repeat(500)}`); // ~137 tokens
      expect(itemCost(oversized)).toBeGreaterThan(1_000);
      expect(itemCost(small)).toBeLessThan(1_000);

      const view = assembleView({
        systemPromptItems: [],
        layerOutputItems: [
          oversized,
          small,
        ],
        historyItems: [],
        policy: policyFor(1_000),
      });
      expect(view).toHaveLength(1);
      expect(viewTexts(view)[0].startsWith('small')).toBe(true);
    });

    it.each([
      [
        -1,
        0,
      ],
      [
        0,
        1,
      ],
      [
        1,
        1,
      ],
    ])('exact-fit boundary: budget = cost%+d keeps %d item(s)', (delta, keptCount) => {
      const item = makeMessage('developer', 'exact-fit-content');
      const view = assembleView({
        systemPromptItems: [],
        layerOutputItems: [
          item,
        ],
        historyItems: [],
        policy: policyFor(itemCost(item) + delta),
      });
      expect(view).toHaveLength(keptCount);
    });

    it('[fits, oversized, fits] keeps the first and third items', () => {
      const a = makeMessage('developer', 'aaa-fits');
      const big = makeMessage('developer', 'Z'.repeat(8_000));
      const c = makeMessage('developer', 'ccc-fits');
      const view = assembleView({
        systemPromptItems: [],
        layerOutputItems: [
          a,
          big,
          c,
        ],
        historyItems: [],
        policy: policyFor(itemCost(a) + itemCost(c)),
      });
      expect(viewTexts(view)).toEqual([
        'aaa-fits',
        'ccc-fits',
      ]);
    });

    it('equal-cost items: the lower-slot (earlier) item wins the last budget slot', () => {
      const first = makeMessage('developer', 'slot-low-AAA');
      const second = makeMessage('developer', 'slot-hi-BBBB');
      expect(itemCost(first)).toBe(itemCost(second));
      const view = assembleView({
        systemPromptItems: [],
        layerOutputItems: [
          first,
          second,
        ],
        historyItems: [],
        policy: policyFor(itemCost(first)),
      });
      expect(viewTexts(view)).toEqual([
        'slot-low-AAA',
      ]);
    });
  });
});
