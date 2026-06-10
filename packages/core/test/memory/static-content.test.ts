import { describe, expect, it } from 'bun:test';
import type { MemoryLayer } from '@noetic-tools/memory';
import {
  createLayerStateStore,
  initLayers,
  recallLayers,
  Slot,
  staticContent,
} from '@noetic-tools/memory';
import { frameworkCast } from '@noetic-tools/types';
import { makeCtx, makeItemLog, makeStorage } from '../_helpers';

function asLayers(layer: MemoryLayer<string>): MemoryLayer[] {
  return frameworkCast<MemoryLayer[]>([
    layer,
  ]);
}

describe('staticContent', () => {
  it('loads content at init and recalls as tagged string', async () => {
    const layer = staticContent({
      load: async () => 'You are a helpful assistant.',
    });
    const store = createLayerStateStore();
    const ctx = makeCtx({
      executionId: 'exec-static',
    });
    const layers = asLayers(layer);

    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });

    const results = await recallLayers({
      layers,
      query: 'q',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          layer.id,
          1e3,
        ],
      ]),
      store,
    });

    expect(results).toHaveLength(1);
    expect(results[0].items).toHaveLength(1);
    expect(results[0].items[0].type).toBe('message');
  });

  it('uses default id, slot, and scope', () => {
    const layer = staticContent({
      load: async () => 'content',
    });
    expect(layer.id).toBe('static-content');
    expect(layer.slot).toBe(Slot.WORKING_MEMORY + 5);
    expect(layer.scope).toBe('resource');
  });

  it('allows custom tag', async () => {
    const layer = staticContent({
      load: async () => 'rules here',
      tag: 'rules',
    });
    const store = createLayerStateStore();
    const ctx = makeCtx({
      executionId: 'exec-tag',
    });
    const layers = asLayers(layer);

    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });

    const state = store.get<string>(ctx.executionId, layer.id);
    expect(state).toBe('<rules>\nrules here\n</rules>');
  });

  it('returns null when content is empty', async () => {
    const layer = staticContent({
      load: async () => '',
    });
    const store = createLayerStateStore();
    const ctx = makeCtx({
      executionId: 'exec-empty',
    });
    const layers = asLayers(layer);

    await initLayers({
      layers,
      ctx,
      storage: makeStorage(),
      store,
    });

    const results = await recallLayers({
      layers,
      query: 'q',
      ctx,
      log: makeItemLog(),
      budgets: new Map([
        [
          layer.id,
          1e3,
        ],
      ]),
      store,
    });

    expect(results).toHaveLength(0);
  });

  it('omits name field', () => {
    const layer = staticContent({
      load: async () => 'content',
    });
    expect('name' in layer).toBe(false);
  });

  describe('budget trim (M4)', () => {
    async function recallWithBudget(content: string, budget: number): Promise<string> {
      const layer = staticContent({
        load: async () => content,
      });
      const store = createLayerStateStore();
      const ctx = makeCtx({
        executionId: `exec-trim-${budget}`,
      });
      const layers = asLayers(layer);
      await initLayers({
        layers,
        ctx,
        storage: makeStorage(),
        store,
      });
      const result = await layer.hooks.recall?.({
        log: makeItemLog(),
        query: '',
        ctx,
        state: store.get<string>(ctx.executionId, layer.id) ?? '',
        budget,
      });
      if (typeof result !== 'string') {
        throw new Error('expected string recall result');
      }
      return result;
    }

    const BIG = 'x'.repeat(4_000); // ~1000 tokens; state adds <instructions> wrapper

    it('trimmed output ends with the closing tag and fits the budget', async () => {
      const out = await recallWithBudget(BIG, 100);
      expect(out.endsWith('\n</instructions>')).toBe(true);
      expect(out.length).toBeLessThanOrEqual(100 * 4);
      expect(out.startsWith('<instructions>')).toBe(true);
    });

    it.each([
      99,
      100,
      101,
    ])('budget %d output always stays within budget*4 chars with closing tag', async (budget) => {
      const out = await recallWithBudget(BIG, budget);
      expect(out.length).toBeLessThanOrEqual(budget * 4);
      expect(out.endsWith('</instructions>')).toBe(true);
    });

    it('tiny budget still emits a well-formed closing tag', async () => {
      const out = await recallWithBudget(BIG, 5);
      expect(out.endsWith('</instructions>')).toBe(true);
      expect(out.length).toBeLessThanOrEqual(5 * 4);
    });

    it('budget 0 returns the full content untrimmed (deliberate fail-open)', async () => {
      const out = await recallWithBudget(BIG, 0);
      expect(out).toBe(`<instructions>\n${BIG}\n</instructions>`);
    });

    it('content already within budget is returned unchanged', async () => {
      const out = await recallWithBudget('short rules', 1e3);
      expect(out).toBe('<instructions>\nshort rules\n</instructions>');
    });
  });
});
