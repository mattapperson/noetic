import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import {
  compactHistory,
  compactionAsItem,
  createCompaction,
  foldCompactions,
  hasCompaction,
  historyPressure,
} from '@noetic-tools/context';
import type { Item, ProjectionPolicy } from '@noetic-tools/types';
import {
  COMPACTION_ITEM_TYPE,
  estimateTokens,
  frameworkCast,
  isNoeticError,
} from '@noetic-tools/types';
import { ItemLogImpl } from '../../src/runtime/item-log-impl';
import { makeFunctionCall, makeFunctionCallOutput, makeMessage } from '../_helpers';

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

/** Read the rendered summary text out of a folded view's leading item. */
function summaryTextOf(view: Item[]): string {
  const head = view[0];
  assert(head.type === 'message');
  const part = head.content[0];
  assert('text' in part && typeof part.text === 'string');
  return part.text;
}

describe('foldCompactions', () => {
  const history = [
    makeMessage('user', 'old-1'),
    makeMessage('assistant', 'old-2'),
    makeMessage('user', 'old-3'),
    makeMessage('user', 'recent-1'),
  ];

  it('passes history through when no compaction exists', () => {
    expect(foldCompactions(history)).toEqual(history);
  });

  it('replaces the covered prefix with a rendered summary', () => {
    const compaction = createCompaction({
      items: history,
      replacesUntil: 3,
      summary: 'the user discussed old things',
    });
    const folded = foldCompactions([
      ...history,
      compactionAsItem(compaction),
    ]);
    expect(folded).toHaveLength(2); // summary + recent-1
    expect(summaryTextOf(folded)).toContain('the user discussed old things');
    expect(viewTexts(folded.slice(1))).toEqual([
      'recent-1',
    ]);
  });

  it('the highest replacesUntil wins when compactions stack', () => {
    const first = createCompaction({
      items: history,
      replacesUntil: 2,
      summary: 'first summary',
    });
    const log: Item[] = [
      ...history,
      compactionAsItem(first),
      makeMessage('user', 'after-first'),
    ];
    const second = createCompaction({
      items: log,
      replacesUntil: 5, // covers history + first compaction
      summary: 'second summary',
    });
    const folded = foldCompactions([
      ...log,
      compactionAsItem(second),
    ]);
    const summary = summaryTextOf(folded);
    expect(summary).toContain('second summary');
    expect(summary).not.toContain('first summary');
    expect(viewTexts(folded.slice(1))).toEqual([
      'after-first',
    ]);
  });

  it('compaction items never leak into the folded view', () => {
    const compaction = createCompaction({
      items: history,
      replacesUntil: 2,
      summary: 's',
    });
    const folded = foldCompactions([
      ...history,
      compactionAsItem(compaction),
    ]);
    expect(folded.some((i) => i.type === COMPACTION_ITEM_TYPE)).toBe(false);
  });

  it('strips a tool call whose output the fold compacted away', () => {
    // The call survives the fold boundary but its output does not — an
    // unresolved call would make the provider reject the request.
    const log: Item[] = [
      makeFunctionCall('search', '{}', 'call-1'),
      makeFunctionCallOutput('call_call-1', 'results'),
      makeMessage('user', 'next'),
    ];
    const compaction = createCompaction({
      items: log,
      replacesUntil: 2,
      summary: 'searched and got results',
    });
    const folded = foldCompactions([
      ...log,
      compactionAsItem(compaction),
    ]);
    expect(folded.some((i) => i.type === 'function_call')).toBe(false);
    expect(folded.some((i) => i.type === 'function_call_output')).toBe(false);
  });
});

describe('hasCompaction', () => {
  it('is false for an uncompacted log and true once a record is present', () => {
    const history = [
      makeMessage('user', 'a'),
    ];
    expect(hasCompaction(history)).toBe(false);
    const compaction = createCompaction({
      items: history,
      replacesUntil: 1,
      summary: 's',
    });
    expect(
      hasCompaction([
        ...history,
        compactionAsItem(compaction),
      ]),
    ).toBe(true);
  });
});

describe('createCompaction', () => {
  it('records replaced count and token savings', () => {
    const items = [
      makeMessage('user', 'a'.repeat(400)),
      makeMessage('assistant', 'b'.repeat(400)),
    ];
    const compaction = createCompaction({
      items,
      replacesUntil: 2,
      summary: 'short',
    });
    expect(compaction.type).toBe(COMPACTION_ITEM_TYPE);
    expect(compaction.replacedCount).toBe(2);
    expect(compaction.summary).toBe('short');
    expect(compaction.tokensSaved).toBeGreaterThan(0);
  });

  it('tokensSaved floors at 0 when the summary is longer than what it replaces', () => {
    const compaction = createCompaction({
      items: [
        makeMessage('user', 'hi'),
      ],
      replacesUntil: 1,
      summary: 'x'.repeat(4_000),
    });
    expect(compaction.tokensSaved).toBe(0);
  });
});

describe('compactHistory', () => {
  const log = [
    makeMessage('user', 'turn-1'),
    makeMessage('assistant', 'turn-2'),
    makeMessage('user', 'turn-3'),
    makeMessage('user', 'turn-4'),
  ];

  it('summarizes everything but the most recent N items', async () => {
    const compaction = await compactHistory({
      log,
      keepRecent: 1,
      summarize: (replaced) => `summarized ${replaced.length}`,
    });
    assert(compaction !== null);
    expect(compaction.replacesUntil).toBe(3);
    expect(compaction.summary).toBe('summarized 3');
    const folded = foldCompactions([
      ...log,
      compactionAsItem(compaction),
    ]);
    expect(viewTexts(folded.slice(1))).toEqual([
      'turn-4',
    ]);
  });

  it('returns null when keepRecent covers the whole log', async () => {
    const compaction = await compactHistory({
      log,
      keepRecent: log.length,
      summarize: () => 'unused',
    });
    expect(compaction).toBeNull();
  });

  it('awaits an async summarizer (an LLM step is the intended shape)', async () => {
    const compaction = await compactHistory({
      log,
      keepRecent: 2,
      summarize: async () => {
        await Promise.resolve();
        return 'async summary';
      },
    });
    assert(compaction !== null);
    expect(compaction.summary).toBe('async summary');
  });
});

describe('historyPressure', () => {
  const policy: ProjectionPolicy = {
    tokenBudget: 1_000,
    responseReserve: 200,
    overflow: 'sliding_window',
  };

  it('reports under-threshold for small histories', () => {
    const pressure = historyPressure(
      [
        makeMessage('user', 'hi'),
      ],
      policy,
    );
    expect(pressure.overThreshold).toBe(false);
    expect(pressure.compactAt).toBe(Math.floor((1_000 - 200) * 0.8));
  });

  it('reports over-threshold when folded history exceeds compactAt', () => {
    const big = Array.from(
      {
        length: 40,
      },
      (_, i) => makeMessage('user', `msg-${i} ${'y'.repeat(120)}`),
    );
    const pressure = historyPressure(big, policy);
    expect(pressure.overThreshold).toBe(true);
    expect(pressure.historyTokens).toBeGreaterThan(pressure.compactAt);
  });

  it('measures the FOLDED history — compaction relieves pressure', () => {
    const big = Array.from(
      {
        length: 40,
      },
      (_, i) => makeMessage('user', `msg-${i} ${'z'.repeat(120)}`),
    );
    expect(historyPressure(big, policy).overThreshold).toBe(true);
    const compaction = createCompaction({
      items: big,
      replacesUntil: 38,
      summary: 'earlier messages summarized',
    });
    const relieved = historyPressure(
      [
        ...big,
        compactionAsItem(compaction),
      ],
      policy,
    );
    expect(relieved.overThreshold).toBe(false);
  });

  it('respects an explicit compactAt override', () => {
    const pressure = historyPressure(
      [
        makeMessage('user', 'x'.repeat(4_000)),
      ],
      {
        tokenBudget: 1_000_000,
        responseReserve: 0,
        overflow: 'sliding_window',
        compactAt: 100,
      },
    );
    expect(pressure.compactAt).toBe(100);
    expect(pressure.overThreshold).toBe(true);
  });
});

// A compaction record is only worth writing down if it can actually be written
// down: it has to pass the strict item-schema registry that guards every append,
// or the "compaction survives checkpoint/resume" claim is false.
describe('compaction in a real ItemLog', () => {
  it('appends to a log under the default strict schema registry', () => {
    const log = new ItemLogImpl();
    log.append(makeMessage('user', 'turn-1'));
    log.append(makeMessage('assistant', 'turn-2'));
    const compaction = createCompaction({
      items: log.items,
      replacesUntil: 2,
      summary: 'the opening exchange',
    });
    expect(() => log.append(compactionAsItem(compaction))).not.toThrow();
    expect(log.items).toHaveLength(3);
    expect(log.items[2].type).toBe(COMPACTION_ITEM_TYPE);
  });

  it('the compaction allowance did not open the gate for other unknown types', () => {
    const log = new ItemLogImpl();
    try {
      // Structurally identical to a compaction record apart from the `type`
      // string, so only the registry's allow-list can be what rejects it.
      log.append(
        frameworkCast<Item>({
          id: 'y',
          type: 'noetic:not_a_real_type',
          status: 'completed',
          replacesUntil: 0,
          summary: '',
          replacedCount: 0,
        }),
      );
      expect.unreachable('should have thrown');
    } catch (e) {
      assert(isNoeticError(e));
      expect(e.noeticError.kind).toBe('item_schema_mismatch');
    }
  });

  it('a compacted log round-trips: the raw log keeps every item, the view shrinks', () => {
    const log = new ItemLogImpl();
    for (let i = 0; i < 10; i++) {
      log.append(makeMessage('user', `turn-${i}`));
    }
    const before = foldCompactions(log.items);
    expect(before).toHaveLength(10);

    const compaction = createCompaction({
      items: log.items,
      replacesUntil: 8,
      summary: 'turns 0 through 7',
    });
    log.append(compactionAsItem(compaction));

    // The log is the durable record — nothing was destroyed, which is what makes
    // this survive a checkpoint.
    expect(log.items).toHaveLength(11);
    // The model's view is what shrank.
    const after = foldCompactions(log.items);
    expect(after).toHaveLength(3); // summary + turn-8 + turn-9
    expect(summaryTextOf(after)).toContain('turns 0 through 7');
    expect(viewTexts(after.slice(1))).toEqual([
      'turn-8',
      'turn-9',
    ]);
  });

  it('serializing and rehydrating a compacted log preserves the folded view', () => {
    const log = new ItemLogImpl();
    for (let i = 0; i < 6; i++) {
      log.append(makeMessage('user', `turn-${i}`));
    }
    const compaction = createCompaction({
      items: log.items,
      replacesUntil: 4,
      summary: 'the first four turns',
    });
    log.append(compactionAsItem(compaction));
    const expected = foldCompactions(log.items);

    // Round-trip through JSON the way a checkpoint does, then re-append through
    // the registry — the compaction has to survive validation a second time.
    const revived = new ItemLogImpl();
    for (const item of JSON.parse(JSON.stringify(log.items))) {
      revived.append(item);
    }
    expect(revived.items).toHaveLength(7);
    const folded = foldCompactions(revived.items);
    expect(folded).toHaveLength(expected.length);
    expect(summaryTextOf(folded)).toContain('the first four turns');
  });
});

// estimateTokens participates in the fold contract (tokensSaved) — pin its shape.
describe('token estimation contract', () => {
  it('longer content estimates more tokens', () => {
    expect(estimateTokens('a'.repeat(1_000))).toBeGreaterThan(estimateTokens('a'));
  });
});
