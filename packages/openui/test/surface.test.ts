import { describe, expect, test } from 'bun:test';
import type { Item } from '@noetic-tools/types';
import type { OpenUiSurfaceState } from '../src';
import { createUiEventItem, openUiSurface, parseDocument, ui } from '../src';
import { makeExecCtx, makeItemLog, makeResponse, makeStorage, testLibrary } from './_helpers';

function makeSurface() {
  return openUiSurface({
    library: testLibrary(),
  });
}

async function initState(surface = makeSurface(), seed?: OpenUiSurfaceState) {
  const storage = makeStorage(
    seed
      ? {
          state: seed,
        }
      : undefined,
  );
  const init = surface.hooks.init;
  if (!init) {
    throw new Error('surface must define init');
  }
  const { state } = await init({
    storage,
    scopeKey: 'thread-1',
    ctx: makeExecCtx(),
  });
  return {
    surface,
    storage,
    state,
  };
}

const RENDER = [
  '$tab = "a"',
  'chart = Card("Sales")',
  'root = Stack([chart])',
].join('\n');

async function foldRender(
  surface: ReturnType<typeof makeSurface>,
  state: OpenUiSurfaceState,
  text = RENDER,
) {
  const afterModelCall = surface.hooks.afterModelCall;
  if (!afterModelCall) {
    throw new Error('surface must define afterModelCall');
  }
  return afterModelCall({
    response: makeResponse(text),
    ctx: makeExecCtx(),
    state,
  });
}

describe('openUiSurface init', () => {
  test('defaults to an empty version-0 state', async () => {
    const { state } = await initState();
    expect(state.version).toBe(0);
    expect(state.document.order).toEqual([]);
    expect(state.appliedEventSeq).toBe(-1);
  });

  test('rehydrates saved state from ScopedStorage', async () => {
    const saved: OpenUiSurfaceState = {
      document: parseDocument(RENDER),
      vars: {
        tab: 'b',
      },
      interactions: [],
      version: 4,
      appliedEventSeq: 7,
    };
    const { state, surface } = await initState(makeSurface(), saved);
    expect(state.version).toBe(4);
    expect(state.vars.tab).toBe('b');
    expect(surface.readState()?.version).toBe(4);
  });
});

describe('afterModelCall folding', () => {
  test('folds a valid render into the document and bumps version', async () => {
    const { surface, state } = await initState();
    const result = await foldRender(surface, state);
    expect(result.decision.action).toBe('allow');
    expect(result.state?.version).toBe(1);
    expect(result.state?.document.root).toBe('root');
    expect(surface.readState()?.version).toBe(1);
  });

  test('non-Lang assistant text leaves state untouched', async () => {
    const { surface, state } = await initState();
    const result = await foldRender(surface, state, 'Sure, here is a summary of the sales data.');
    expect(result.decision.action).toBe('allow');
    expect(result.state).toBeUndefined();
  });

  test('library violations guide the model and land in the trace', async () => {
    const { surface, state } = await initState();
    const ctx = makeExecCtx();
    const afterModelCall = surface.hooks.afterModelCall;
    if (!afterModelCall) {
      throw new Error('surface must define afterModelCall');
    }
    const result = await afterModelCall({
      response: makeResponse('root = Sparkline([1])'),
      ctx,
      state,
    });
    expect(result.decision.action).toBe('guide');
    expect(result.decision.guidance).toContain("unknown component 'Sparkline'");
    // still folds — the client may render known parts; version must advance
    expect(result.state?.version).toBe(1);
    expect(ctx.traceEvents.some((e) => e.name === 'openui.validation')).toBe(true);
  });
});

describe('onItemAppend ui-event reduction', () => {
  async function applyItems(state: OpenUiSurfaceState, items: Item[], surface = makeSurface()) {
    const onItemAppend = surface.hooks.onItemAppend;
    if (!onItemAppend) {
      throw new Error('surface must define onItemAppend');
    }
    return onItemAppend({
      items,
      log: makeItemLog(),
      ctx: makeExecCtx(),
      state,
    });
  }

  test('set events mirror into vars and are dropped from the item pipeline', async () => {
    const { state } = await initState();
    const result = await applyItems(state, [
      createUiEventItem({
        kind: 'set',
        ref: 'tab',
        payload: 'b',
        seq: 0,
      }),
    ]);
    expect(result.items).toEqual([]);
    expect(result.state?.vars.tab).toBe('b');
    expect(result.state?.version).toBe(1);
    expect(result.rerender).toBe(true);
    expect(result.timing).toBe('immediate');
  });

  test('submit events append interactions and stay in the pipeline', async () => {
    const { state } = await initState();
    const item = createUiEventItem({
      kind: 'submit',
      ref: 'checkout-form',
      payload: {
        name: 'Matt',
      },
      seq: 1,
    });
    const result = await applyItems(state, [
      item,
    ]);
    expect(result.items).toEqual([
      item,
    ]);
    expect(result.state?.interactions).toHaveLength(1);
    expect(result.state?.interactions[0]?.ref).toBe('checkout-form');
  });

  test('duplicate seqs are dedeuplicated: seq at, below, and above the applied watermark', async () => {
    const { state } = await initState();
    const first = await applyItems(state, [
      createUiEventItem({
        kind: 'submit',
        ref: 'f',
        seq: 5,
      }),
    ]);
    const next = first.state;
    if (!next) {
      throw new Error('expected state');
    }
    // seq === watermark → dropped; seq < watermark → dropped; seq > watermark → applied
    for (const [seq, expected] of [
      [
        5,
        1,
      ],
      [
        4,
        1,
      ],
      [
        6,
        2,
      ],
    ] as const) {
      const result = await applyItems(next, [
        createUiEventItem({
          kind: 'submit',
          ref: 'f',
          seq,
        }),
      ]);
      expect((result.state ?? next).interactions).toHaveLength(expected);
    }
  });

  test('events versioned against an older document are flagged stale', async () => {
    const { surface, state } = await initState();
    const folded = await foldRender(surface, state);
    if (!folded.state) {
      throw new Error('expected state');
    }
    const result = await applyItems(folded.state, [
      createUiEventItem({
        kind: 'action',
        ref: 'save',
        seq: 0,
        version: 0, // rendered against v0, surface is at v1
      }),
    ]);
    expect(result.state?.interactions[0]?.stale).toBe(true);
  });

  test('non-ui items pass through untouched', async () => {
    const { state } = await initState();
    const item: Item = {
      id: 'x',
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [
        {
          type: 'input_text',
          text: 'hi',
        },
      ],
    };
    const result = await applyItems(state, [
      item,
    ]);
    expect(result.items).toEqual([
      item,
    ]);
    expect(result.rerender).toBe(false);
  });
});

describe('recall', () => {
  test('returns null before anything rendered (version 0)', async () => {
    const { surface, state } = await initState();
    const recall = surface.hooks.recall;
    if (!recall) {
      throw new Error('surface must define recall');
    }
    expect(
      await recall({
        log: makeItemLog(),
        query: '',
        ctx: makeExecCtx(),
        state,
        budget: 500,
      }),
    ).toBeNull();
  });

  test('renders a <ui_surface> block and trims to budget; zero budget is fail-open', async () => {
    const { surface, state } = await initState();
    const folded = await foldRender(surface, state);
    if (!folded.state) {
      throw new Error('expected state');
    }
    const many: OpenUiSurfaceState = {
      ...folded.state,
      interactions: Array.from(
        {
          length: 60,
        },
        (_, i) => ({
          kind: 'action' as const,
          ref: `a${i}`,
          seq: i,
        }),
      ),
    };
    const recall = surface.hooks.recall;
    if (!recall) {
      throw new Error('surface must define recall');
    }
    const full = await recall({
      log: makeItemLog(),
      query: '',
      ctx: makeExecCtx(),
      state: many,
      budget: 0,
    });
    const trimmed = await recall({
      log: makeItemLog(),
      query: '',
      ctx: makeExecCtx(),
      state: many,
      budget: 100,
    });
    if (
      full === null ||
      typeof full === 'string' ||
      trimmed === null ||
      typeof trimmed === 'string'
    ) {
      throw new Error('expected RecallResult objects');
    }
    // zero budget → fail-open full render, larger than the trimmed one
    expect(full.tokenCount).toBeGreaterThan(trimmed.tokenCount);
    expect(trimmed.tokenCount).toBeLessThanOrEqual(100);
  });
});

describe('projectHistory', () => {
  test('collapses superseded renders, keeping the newest', async () => {
    const { surface, state } = await initState();
    const projectHistory = surface.hooks.projectHistory;
    if (!projectHistory) {
      throw new Error('surface must define projectHistory');
    }
    const older: Item = {
      id: '1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'root = Card("v1")',
        },
      ],
    };
    const prose: Item = {
      id: '2',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'Here is your dashboard.',
        },
      ],
    };
    const newest: Item = {
      id: '3',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'root = Card("v2")',
        },
      ],
    };
    const result = await projectHistory({
      items: [
        older,
        prose,
        newest,
      ],
      ctx: makeExecCtx(),
      state,
    });
    const texts = result.items.map((i) =>
      i.type === 'message' && 'text' in (i.content[0] ?? {})
        ? Reflect.get(i.content[0] ?? {}, 'text')
        : '',
    );
    expect(texts[0]).toContain('superseded');
    expect(texts[1]).toBe('Here is your dashboard.');
    expect(texts[2]).toBe('root = Card("v2")');
  });
});

describe('spawn boundaries', () => {
  test('onSpawn clones; onReturn merges only new child interactions', async () => {
    const { surface, state } = await initState();
    const onSpawn = surface.hooks.onSpawn;
    const onReturn = surface.hooks.onReturn;
    if (!onSpawn || !onReturn) {
      throw new Error('surface must define onSpawn/onReturn');
    }
    const withInteraction: OpenUiSurfaceState = {
      ...state,
      interactions: [
        {
          kind: 'submit',
          ref: 'a',
          seq: 1,
        },
      ],
      version: 2,
    };
    const spawned = await onSpawn({
      parentState: withInteraction,
      childCtx: makeExecCtx(),
    });
    expect(spawned?.childState).toEqual(withInteraction);
    expect(spawned?.childState).not.toBe(withInteraction);

    const childState: OpenUiSurfaceState = {
      ...structuredClone(withInteraction),
      interactions: [
        ...withInteraction.interactions,
        {
          kind: 'action',
          ref: 'child-action',
          seq: 9,
        },
      ],
    };
    const merged = await onReturn({
      childState,
      childLog: makeItemLog(),
      parentState: withInteraction,
      result: undefined,
    });
    expect(merged?.parentState.interactions.map((i) => i.seq)).toEqual([
      1,
      9,
    ]);
    // parent keeps ownership of document + version
    expect(merged?.parentState.version).toBe(2);
  });
});

describe('ui predicates', () => {
  test('read the live mirror: no interactions → continue, matching submit → stop', async () => {
    const surface = makeSurface();
    const snap = {
      stepCount: 1,
      tokens: {
        input: 0,
        output: 0,
        total: 0,
      },
      elapsed: 0,
      cost: 0,
      lastOutput: undefined,
      lastText: '',
      history: [],
      depth: 0,
    };
    expect(ui.submitted(surface, 'checkout')(snap)).toEqual({
      stop: false,
      reason: undefined,
    });

    const { state } = await initState(surface);
    const onItemAppend = surface.hooks.onItemAppend;
    if (!onItemAppend) {
      throw new Error('surface must define onItemAppend');
    }
    await onItemAppend({
      items: [
        createUiEventItem({
          kind: 'submit',
          ref: 'checkout',
          seq: 0,
        }),
      ],
      log: makeItemLog(),
      ctx: makeExecCtx(),
      state,
    });
    expect(ui.submitted(surface, 'checkout')(snap).stop).toBe(true);
    expect(ui.submitted(surface, 'other-form')(snap).stop).toBe(false);
    expect(ui.interacted(surface)(snap).stop).toBe(true);
    expect(ui.interacted(surface, 'toAssistant')(snap).stop).toBe(false);
    expect(ui.toAssistant(surface)(snap).stop).toBe(false);
  });
});
