/**
 * ADVERSARIAL AUDIT — temporalMemory() & observationalMemory().
 *
 * Each test asserts the CORRECT behavior. A FAILING test = a confirmed bug in
 * the layer. Tests that pass are NOT bugs.
 *
 * Contract reminders:
 * - recall({ budget }) is TRUSTED to self-limit its output to `budget` tokens;
 *   nothing downstream enforces it (spec 12, "Checklist" item 5: "Respect the
 *   `budget` parameter in recall(). Trim your output to fit.").
 * - temporalMemory caps the ledger to `maxFacts` ("oldest dropped beyond this").
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { observationalMemory } from '../../../src/memory/layers/observational-memory';
import { temporalMemory } from '../../../src/memory/layers/temporal';
import type { Item } from '../../../src/types/items';
import { frameworkCast } from '../../../src/util/framework-cast';
import { estimateTokens } from '../../../src/util/message-helpers';
import { assistantMessage, makeCtx, makeItemLog, makeScopedStorage } from '../../_helpers';

// A ~25-token chunk of text used to build oversized recall payloads.
const LONG = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do';

function rendered(result: { items: Item[] }): string {
  const msg = result.items[0];
  assert(msg.type === 'message');
  return msg.content.map((p) => ('text' in p ? p.text : '')).join('');
}

describe('AUDIT observationalMemory', () => {
  it('BUG: recall must trim output to the token budget', async () => {
    const layer = observationalMemory();
    const observations = Array.from(
      {
        length: 40,
      },
      (_, i) => `${LONG} observation ${i}`,
    );
    const state = {
      observations,
      buffer: [],
      bufferTokens: 0,
      version: 1,
    };

    const budget = 50;
    const result = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx: makeCtx(),
      state,
      budget,
    });

    assert(result !== null);
    assert(typeof result !== 'string');
    // Correct behavior: a layer must self-limit to its budget.
    expect(result.tokenCount).toBeLessThanOrEqual(budget);
    // And the actually-rendered text must also fit.
    expect(estimateTokens(rendered(result))).toBeLessThanOrEqual(budget);
  });
});

describe('AUDIT temporalMemory', () => {
  it('BUG: recall(injectLedger) must trim output to the token budget', async () => {
    const layer = temporalMemory({
      injectLedger: true,
      groundDateTime: false,
      now: () => new Date('2020-01-01T00:00:00Z'),
    });

    const init = await layer.hooks.init!({
      storage: makeScopedStorage(),
      scopeKey: 'user-1',
      ctx: makeCtx(),
    });

    const facts: Record<string, string[]> = {};
    for (let i = 0; i < 40; i++) {
      const ts = `2020-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`;
      const list = facts[ts] ?? [];
      list.push(`${LONG} fact ${i}`);
      facts[ts] = list;
    }
    const state = {
      ...init.state,
      facts,
    };

    const budget = 50;
    const result = await layer.hooks.recall!({
      log: makeItemLog(),
      query: '',
      ctx: makeCtx(),
      state,
      budget,
    });

    assert(result !== null);
    assert(typeof result !== 'string');
    expect(result.tokenCount).toBeLessThanOrEqual(budget);
    expect(estimateTokens(rendered(result))).toBeLessThanOrEqual(budget);
  });

  it('BUG: ledger cap wipes the newest facts when one extraction exceeds maxFacts', async () => {
    // A single extraction returns 3 facts at the SAME timestamp; maxFacts = 2.
    // Correct behavior: keep up to maxFacts facts. Bug: the whole bucket (the
    // newest and only data) is evicted, leaving an empty ledger.
    const layer = temporalMemory({
      maxFacts: 2,
      bufferThreshold: 1,
      now: () => new Date('2020-06-01T00:00:00Z'),
      extract: async () => [
        {
          ts: '2020-01-01T00:00:00Z',
          fact: 'alpha',
        },
        {
          ts: '2020-01-01T00:00:00Z',
          fact: 'beta',
        },
        {
          ts: '2020-01-01T00:00:00Z',
          fact: 'gamma',
        },
      ],
    });

    const init = await layer.hooks.init!({
      storage: makeScopedStorage(),
      scopeKey: 'user-1',
      ctx: makeCtx(),
    });

    const msg = assistantMessage('this is enough text to cross the one token threshold');
    const result = await layer.hooks.store!({
      newItems: [
        msg,
      ],
      log: makeItemLog(),
      response: {
        items: [
          msg,
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      ctx: makeCtx(),
      state: init.state,
    });

    assert(result !== undefined);
    const total = Object.values(result.state.facts).reduce((n, list) => n + list.length, 0);
    // Correct: cap retains maxFacts (2). Bug: total is 0 — everything evicted.
    expect(total).toBe(2);
  });

  it('CONTROL: ledger cap across multiple timestamps drops oldest only (should PASS)', async () => {
    const layer = temporalMemory({
      maxFacts: 2,
      bufferThreshold: 1,
      now: () => new Date('2020-06-01T00:00:00Z'),
      extract: async () => [
        {
          ts: '2020-01-01T00:00:00Z',
          fact: 'oldest',
        },
        {
          ts: '2020-02-01T00:00:00Z',
          fact: 'middle',
        },
        {
          ts: '2020-03-01T00:00:00Z',
          fact: 'newest',
        },
      ],
    });

    const init = await layer.hooks.init!({
      storage: makeScopedStorage(),
      scopeKey: 'user-1',
      ctx: makeCtx(),
    });

    const msg = assistantMessage('this is enough text to cross the one token threshold');
    const result = await layer.hooks.store!({
      newItems: [
        msg,
      ],
      log: makeItemLog(),
      response: {
        items: [
          msg,
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
      },
      ctx: makeCtx(),
      state: init.state,
    });

    assert(result !== undefined);
    const kept = Object.values(result.state.facts).flat().sort();
    expect(kept).toEqual([
      'middle',
      'newest',
    ]);
  });

  it('PROBE: neither layer captures user/tool input (no onItemAppend hook)', () => {
    // store() only ever receives ASSISTANT response items, and collectText only
    // reads `output_text` (assistant) parts — so user-stated facts and tool
    // outputs are never buffered. The only way to capture INPUT items is the
    // onItemAppend hook, which neither layer implements.
    const obs = observationalMemory();
    const tmp = temporalMemory();
    const obsHooks = frameworkCast<Record<string, unknown>>(obs.hooks);
    const tmpHooks = frameworkCast<Record<string, unknown>>(tmp.hooks);
    expect(obsHooks['onItemAppend']).toBeDefined();
    expect(tmpHooks['onItemAppend']).toBeDefined();
  });
});
