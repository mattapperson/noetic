import { describe, expect, it } from 'bun:test';
import { frameworkCast } from '../../src/interpreter/framework-cast';
import { createLayerStateStore, initLayers, recallLayers } from '../../src/memory/layer-lifecycle';
import { staticContent } from '../../src/memory/layers/static-content';
import type { MemoryLayer } from '../../src/types/memory';
import { Slot } from '../../src/types/memory';
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
});
