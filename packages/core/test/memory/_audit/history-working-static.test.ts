/**
 * ADVERSARIAL AUDIT — memory layers history-window / working-memory / static-content.
 *
 * Each test asserts the CORRECT (intended) behavior so that, where the
 * implementation is buggy, the test FAILS now. Confirmed failures are reported
 * in the audit writeup. Probes that pass document robustness.
 */

import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  createLayerStateStore,
  initLayers,
  recallLayers,
} from '../../../src/memory/layer-lifecycle';
import { historyWindow } from '../../../src/memory/layers/history-window';
import { staticContent } from '../../../src/memory/layers/static-content';
import { workingMemory } from '../../../src/memory/layers/working-memory';
import type { Item } from '../../../src/types/items';
import type { MemoryLayer } from '../../../src/types/memory';
import { frameworkCast } from '../../../src/util/framework-cast';
import {
  getItemId,
  makeCtx,
  makeFunctionCall,
  makeFunctionCallOutput,
  makeItemLog,
  makeLLMResponse,
  makeMessage,
  makeStorage,
} from '../../_helpers';

const STUB_CTX = makeCtx();

async function project(layer: ReturnType<typeof historyWindow>, items: Item[]): Promise<Item[]> {
  if (!layer.hooks.projectHistory) {
    throw new Error('layer missing projectHistory hook');
  }
  const result = await layer.hooks.projectHistory({
    items,
    ctx: STUB_CTX,
    state: null,
  });
  return [
    ...result.items,
  ];
}

//#region history-window probes

describe('AUDIT history-window', () => {
  it('PROBE: cap bounds projected size even when recent turns are tool-only (no assistant text)', async () => {
    // Realistic tool-heavy agent: the assistant emits function_call items with
    // NO accompanying assistant `message` item. The only assistant TEXT message
    // is the very first reply. maxItems is small, but the minimum-exchange
    // expansion walks all the way back to that first assistant message.
    const items: Item[] = [
      makeMessage('user', 'task', 'u-0'),
      makeMessage('assistant', 'ok', 'a-0'),
    ];
    for (let i = 0; i < 100; i++) {
      const call = makeFunctionCall('read', '{}', `fc-${i}`);
      items.push(call);
      items.push(makeFunctionCallOutput(call.callId, 'ok', `fco-${i}`));
    }
    const layer = historyWindow({
      maxItems: 4,
    });
    const projected = await project(layer, items);
    // A layer whose entire purpose is to CAP history should keep the projected
    // size near the cap. assembleView has NO global token cap, so an unbounded
    // window defeats the feature. Expect a sane bound (allow generous slack).
    expect(projected.length).toBeLessThanOrEqual(20);
  });

  it('PROBE: a system/anchor message in history survives windowing', async () => {
    const items: Item[] = [
      makeMessage('system', 'CORE INSTRUCTIONS', 'sys-0'),
    ];
    for (let i = 0; i < 40; i++) {
      if (i % 2 === 0) {
        items.push(makeMessage('user', `m-${i}`, `id-${i}`));
      } else {
        items.push(makeMessage('assistant', `m-${i}`, `id-${i}`));
      }
    }
    const layer = historyWindow({
      maxItems: 4,
    });
    const projected = await project(layer, items);
    const hasSystem = projected.some((it) => getItemId(it) === 'sys-0');
    expect(hasSystem).toBe(true);
  });

  it('PROBE: keeps the latest user message', async () => {
    const items: Item[] = [
      makeMessage('user', 'old', 'u-old'),
      makeMessage('assistant', 'old', 'a-old'),
      makeMessage('user', 'LATEST', 'u-latest'),
      makeMessage('assistant', 'reply', 'a-reply'),
      makeMessage('assistant', 'extra', 'a-extra'),
    ];
    const layer = historyWindow({
      maxItems: 2,
    });
    const projected = await project(layer, items);
    expect(projected.some((it) => getItemId(it) === 'u-latest')).toBe(true);
  });

  it('PROBE: never emits an orphan function_call or function_call_output', async () => {
    const items: Item[] = [
      makeMessage('user', 'q', 'u-0'),
      makeMessage('assistant', 'a', 'a-0'),
    ];
    for (let i = 0; i < 30; i++) {
      const call = makeFunctionCall('read', '{}', `fc-${i}`);
      items.push(call);
      items.push(makeFunctionCallOutput(call.callId, 'ok', `fco-${i}`));
    }
    const layer = historyWindow({
      maxItems: 5,
    });
    const projected = await project(layer, items);
    const callIds = new Set(
      projected
        .filter((i) => i.type === 'function_call')
        .map((i) => (i.type === 'function_call' ? i.callId : '')),
    );
    const outIds = new Set(
      projected
        .filter((i) => i.type === 'function_call_output')
        .map((i) => (i.type === 'function_call_output' ? i.callId : '')),
    );
    for (const id of callIds) {
      expect(outIds.has(id)).toBe(true);
    }
    for (const id of outIds) {
      expect(callIds.has(id)).toBe(true);
    }
  });
});

//#endregion

//#region working-memory probes

function wmStore(layer: ReturnType<typeof workingMemory>, newItems: Item[], state: unknown) {
  if (!layer.hooks.store) {
    throw new Error('no store hook');
  }
  return layer.hooks.store({
    newItems,
    state: frameworkCast<string | Record<string, unknown>>(state),
    log: makeItemLog(),
    response: makeLLMResponse(''),
    ctx: STUB_CTX,
  });
}

describe('AUDIT working-memory', () => {
  it('PROBE: store deep-merges nested objects (spec: "Deep-merges structured state")', async () => {
    const layer = workingMemory({
      schema: z.object({}),
    });
    const state = {
      profile: {
        name: 'Ann',
        age: 30,
      },
      theme: 'dark',
    };
    const call = makeFunctionCall(
      'updateWorkingMemory',
      JSON.stringify({
        profile: {
          age: 31,
        },
      }),
      'fc-uwm',
    );
    const result = await wmStore(
      layer,
      [
        call,
      ],
      state,
    );
    expect(result?.state).toBeDefined();
    const merged = frameworkCast<{
      profile: {
        name?: string;
        age: number;
      };
      theme: string;
    }>(result?.state);
    // Sibling key `name` and top-level `theme` must survive a nested update.
    expect(merged.profile.age).toBe(31);
    expect(merged.profile.name).toBe('Ann');
    expect(merged.theme).toBe('dark');
  });

  it('PROBE: provides.update deep-merges nested objects', async () => {
    const layer = workingMemory({
      schema: z.object({}),
    });
    const decl = layer.provides.update;
    const state = {
      profile: {
        name: 'Ann',
        age: 30,
      },
    };
    const out = await decl.execute(
      {
        profile: {
          age: 31,
        },
      },
      state,
      STUB_CTX,
    );
    const merged = frameworkCast<{
      profile: {
        name?: string;
        age: number;
      };
    }>(out.state);
    expect(merged.profile.age).toBe(31);
    expect(merged.profile.name).toBe('Ann');
  });

  it('PROBE: __proto__ key is stripped from the merged state (spec claims protection)', async () => {
    const layer = workingMemory({
      schema: z.object({}),
    });
    const poison = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
    const call = makeFunctionCall('updateWorkingMemory', JSON.stringify(poison), 'fc-poison');
    const result = await wmStore(
      layer,
      [
        call,
      ],
      {},
    );
    const merged = frameworkCast<Record<string, unknown>>(result?.state);
    // Object.prototype must not be polluted.
    expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    // And the dangerous key must not survive as an own property of the state.
    expect(Object.hasOwn(merged, '__proto__')).toBe(false);
  });

  it('PROBE: an object update does not silently discard prior freeform string state', async () => {
    // Freeform mode (no schema): init defaults state to ''. If an update arrives,
    // the prior freeform content should not be destroyed without trace.
    const layer = workingMemory();
    const call = makeFunctionCall(
      'updateWorkingMemory',
      JSON.stringify({
        note: 'new',
      }),
      'fc-ff',
    );
    const result = await wmStore(
      layer,
      [
        call,
      ],
      'IMPORTANT PRIOR NOTE',
    );
    // The prior freeform note must be retrievable somewhere in the new state.
    const serialized = JSON.stringify(result?.state ?? '');
    expect(serialized.includes('IMPORTANT PRIOR NOTE')).toBe(true);
  });
});

//#endregion

//#region static-content probes

function asLayers(layer: MemoryLayer<string>): MemoryLayer[] {
  return frameworkCast<MemoryLayer[]>([
    layer,
  ]);
}

describe('AUDIT static-content', () => {
  it('PROBE: recall respects the token budget (spec checklist #5)', async () => {
    const big = 'x'.repeat(8000); // ~2000 tokens at 4 chars/token
    const layer = staticContent({
      load: async () => big,
    });
    const store = createLayerStateStore();
    const ctx = makeCtx({
      executionId: 'exec-budget',
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
          100,
        ],
      ]), // tight 100-token budget
      store,
    });
    expect(results).toHaveLength(1);
    expect(results[0].tokenCount).toBeLessThanOrEqual(100);
  });
});

//#endregion
