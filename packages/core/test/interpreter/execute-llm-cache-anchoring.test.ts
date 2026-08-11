import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData, ContextLayer } from '@noetic-tools/context';
import { contextToExecCtx, createLayerStateStore, recallLayers } from '@noetic-tools/context';
import type {
  AgentHarnessContract,
  CallModelRequest,
  ContextCacheConfig,
  Item,
  LLMResponse,
  StepCallModel,
} from '@noetic-tools/types';
import { createMessage, SteeringAction } from '@noetic-tools/types';
import type { BandedView } from '../../src/interpreter/context-assembly';
import { stampAnchoringAttributes } from '../../src/interpreter/context-assembly';
import { executeCallModel } from '../../src/interpreter/execute-action';
import { ContextImpl } from '../../src/runtime/context-impl';
import { makeFunctionCallOutput, makeLLMResponse, makeMockHarness } from '../_helpers';

//#region Helpers

const STEP: StepCallModel<ContextData, string, string> = {
  kind: 'callModel',
  id: 'test',
  model: 'gpt-4',
};

/** A layer whose recall text is whatever `text()` returns at that moment. */
function textLayer(
  id: string,
  text: () => string,
  overrides?: Partial<ContextLayer>,
): ContextLayer {
  return {
    id,
    slot: 100,
    scope: 'thread',
    hooks: {
      async recall() {
        return text();
      },
    },
    ...overrides,
  };
}

function texts(items: ReadonlyArray<Item>): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.type !== 'message' || !('content' in item)) {
      continue;
    }
    for (const part of item.content ?? []) {
      if ('text' in part && typeof part.text === 'string') {
        out.push(part.text);
      }
    }
  }
  return out;
}

/** Text of the nth captured request, asserting it was actually made. */
function textsAt(requests: ReadonlyArray<CallModelRequest>, index: number): string[] {
  const request = requests[index];
  assert(request !== undefined, `expected a model call at index ${index}`);
  return texts(request.items);
}

/**
 * A mock harness running the REAL recall lifecycle, so state mutation, `null`
 * returns and `renderDelta` behave as they do in production. The default mock
 * returns canned output, which would bypass everything under test here.
 */
function withCapture(opts?: { responses?: () => LLMResponse; contextCache?: ContextCacheConfig }) {
  const base = makeMockHarness();
  const requests: CallModelRequest[] = [];
  const store = createLayerStateStore();

  // Assign onto the object the mock's own `recallLayersAtomic` closes over —
  // it delegates to `recallLayers` on that object, not on a later copy.
  base.recallLayers = async (layers, query, ctx) =>
    recallLayers({
      layers,
      query,
      ctx: contextToExecCtx(ctx),
      log: ctx.itemLog,
      budgets: new Map(
        layers.map((l) => [
          l.id,
          1_000,
        ]),
      ),
      store,
    });
  base.callModel = async (request) => {
    requests.push(request);
    return opts?.responses ? opts.responses() : makeLLMResponse('done');
  };

  // `config` is readonly, so a config override needs a fresh object.
  const harness: AgentHarnessContract = {
    ...base,
    config: {
      ...base.config,
      contextCache: opts?.contextCache,
    },
  };
  return {
    harness,
    requests,
  };
}

/** Runs `turns` LLM steps against one harness, keeping the thread id fixed. */
async function runTurns(
  harness: ReturnType<typeof makeMockHarness>,
  layers: ContextLayer[],
  turns: number,
): Promise<void> {
  for (let i = 0; i < turns; i++) {
    const ctx = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, `turn-${i}`, ctx, layers);
  }
}

//#endregion

describe('executeCallModel context anchoring', () => {
  it('replays pinned bytes for a layer that re-renders every turn', async () => {
    const { harness, requests } = withCapture();
    let tick = 0;
    const layers = [
      textLayer('clock', () => `now: ${tick++}`),
    ];

    await runTurns(harness, layers, 3);

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(texts(request.items)).toContain('now: 0');
    }
  });

  // The point of the whole feature: what the model reads before history must not
  // move, or the prompt cache is re-billed every turn. Compares the whole band
  // — several layers, one of them churning — not a single item.
  it('holds the anchor prefix byte-identical across turns', async () => {
    const { harness, requests } = withCapture();
    let tick = 0;
    const layers = [
      textLayer('stable', () => 'STABLE BLOCK', {
        slot: 50,
      }),
      textLayer('clock', () => `now: ${tick++}`, {
        slot: 100,
      }),
      textLayer('also-stable', () => 'ALSO STABLE', {
        slot: 150,
      }),
    ];

    await runTurns(harness, layers, 4);

    // The band is everything up to the first history item ('turn-N').
    const bands = requests.map((r) => {
      const seen = texts(r.items);
      const end = seen.findIndex((t) => t.startsWith('turn-'));
      return JSON.stringify(seen.slice(0, end === -1 ? seen.length : end));
    });

    expect(bands[0]).toBe('["STABLE BLOCK","now: 0","ALSO STABLE"]');
    expect(new Set(bands).size).toBe(1);
  });

  // An execution-scoped layer's pin key must not rotate with its scope key, or
  // every turn retracts the "old" pin and adds a "new" one for the same layer.
  it('pins an execution-scoped layer across turns like any other', async () => {
    const { harness, requests } = withCapture();
    const layers = [
      textLayer('tool-ctx', () => 'TOOL STATE', {
        scope: 'execution',
      }),
    ];

    await runTurns(harness, layers, 3);

    for (const request of requests) {
      const seen = texts(request.items);
      expect(seen[0]).toBe('TOOL STATE');
      expect(seen.join('\n')).not.toContain('<context_updates');
    }
  });

  // Dropping the pinned block would shorten the prefix and cost far more than
  // the tokens it saves, so it stays and carries a standing retraction.
  it('keeps serving a pinned block after its layer goes quiet', async () => {
    const { harness, requests } = withCapture();
    let quiet = false;
    const layers = [
      textLayer('sometimes', () => (quiet ? '' : 'PRESENT')),
    ];
    const first = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'a', first, layers);
    quiet = true;
    await runTurns(harness, layers, 2);

    for (const request of requests) {
      expect(texts(request.items)[0]).toBe('PRESENT');
    }
    // Every turn after it fell silent must repeat the correction, because the
    // stale block is still sitting in the band.
    for (const request of requests.slice(1)) {
      expect(texts(request.items).join('\n')).toContain('action="retract"');
    }
  });

  // A change the runtime cannot describe must not be published as silence — the
  // pinned block is already in the view and would read as current.
  it('re-anchors rather than leave an undescribable change unpublished', async () => {
    const { harness, requests } = withCapture();
    let second = false;
    const layers: ContextLayer[] = [
      {
        id: 'opaque',
        slot: 100,
        scope: 'thread',
        hooks: {
          async recall() {
            // Non-message items carry no text the runtime can render into a
            // supersede.
            return {
              items: [
                makeFunctionCallOutput(second ? 'call-2' : 'call-1', 'payload'),
              ],
              tokenCount: 5,
            };
          },
        },
      },
    ];
    const first = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'a', first, layers);
    second = true;
    const next = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'b', next, layers);

    const sent = requests[1];
    assert(sent !== undefined);
    const outputs = sent.items.filter((i) => i.type === 'function_call_output');
    // The fresh render reached the model directly instead of a stale replay.
    expect(outputs.some((i) => i.type === 'function_call_output' && i.callId === 'call-2')).toBe(
      true,
    );
    expect(outputs.some((i) => i.type === 'function_call_output' && i.callId === 'call-1')).toBe(
      false,
    );
  });

  it('publishes a layer that first appears mid-epoch as an addition', async () => {
    const { harness, requests } = withCapture();
    const base = textLayer('base', () => 'BASE');
    const late = textLayer('late', () => 'LATE ARRIVAL', {
      slot: 150,
    });

    const first = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'a', first, [
      base,
    ]);
    const second = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'b', second, [
      base,
      late,
    ]);

    const sent = textsAt(requests, 1);
    // The frozen prefix is untouched; the newcomer rides in the supersede.
    expect(sent[0]).toBe('BASE');
    expect(sent.join('\n')).toContain('action="add"');
    expect(sent.join('\n')).toContain('LATE ARRIVAL');
  });

  it('re-anchors when the supersedes outgrow the band they patch', async () => {
    const { harness, requests } = withCapture();
    let tick = 0;
    const layers = [
      // Small pinned block, huge changing payload — pressure by construction.
      textLayer('bloat', () => `${'payload '.repeat(400)}${tick++}`),
    ];

    await runTurns(harness, layers, 2);

    const sent = textsAt(requests, 1);
    // Re-anchored: the fresh render is in the band, nothing was superseded.
    expect(sent[0]).toContain('payload');
    expect(sent[0]).toContain('1');
    expect(sent.join('\n')).not.toContain('<context_updates');
  });

  it('leaves the epoch untouched when a preview looks at the thread', async () => {
    const { harness } = withCapture();
    const layers = [
      textLayer('a', () => 'A'),
    ];
    const ctx = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'x', ctx, layers);

    const store = harness.contextCache;
    assert(store !== undefined);
    const epoch = store.epochs.get('t:thread-1');
    assert(epoch !== undefined);
    const before = {
      assemblies: epoch.assemblies,
      pins: epoch.pins.size,
      anchorTokens: epoch.anchorTokens,
    };
    store.pendingReanchor.set('t:thread-1', 'cache-miss');

    await harness.previewRequestItems({
      threadId: 'thread-1',
    });

    expect(epoch.assemblies).toBe(before.assemblies);
    expect(epoch.pins.size).toBe(before.pins);
    expect(epoch.anchorTokens).toBe(before.anchorTokens);
    // A queued re-anchor must survive being looked at.
    expect(store.pendingReanchor.get('t:thread-1')).toBe('cache-miss');
  });

  it('judges the cache once per assembly, not once per steering retry', async () => {
    const { harness } = withCapture({
      responses: () => ({
        items: [],
        usage: {
          inputTokens: 10_000,
          outputTokens: 5,
          cachedTokens: 0,
        },
        rounds: [
          {
            inputTokens: 10_000,
            outputTokens: 5,
            cachedTokens: 0,
          },
        ],
      }),
    });
    let guided = 0;
    harness.afterModelCall = async () => {
      if (guided >= 2) {
        return {
          action: SteeringAction.Allow,
        };
      }
      guided += 1;
      return {
        action: SteeringAction.Guide,
        guidance: 'again',
      };
    };
    const layers = [
      textLayer('a', () => 'A'),
    ];
    // Enough turns to pass the bootstrap grace so misses are actually counted.
    await runTurns(harness, layers, 3);

    const store = harness.contextCache;
    assert(store !== undefined);
    const epoch = store.epochs.get('t:thread-1');
    assert(epoch !== undefined);
    // Three retries in one turn must not exhaust the give-up threshold.
    expect(epoch.misses).toBeLessThanOrEqual(3);
  });

  it('publishes one supersede carrying the changed content', async () => {
    const { harness, requests } = withCapture();
    let tick = 0;
    const layers = [
      textLayer('clock', () => `now: ${tick++}`),
    ];

    await runTurns(harness, layers, 2);

    const second = textsAt(requests, 1).join('\n');
    expect(second).toContain('<context_updates');
    expect(second).toContain('layer="clock"');
    expect(second).toContain('action="replace"');
    expect(second).toContain('now: 1');
  });

  it('merges several changed layers into a single supersede message', async () => {
    const { harness, requests } = withCapture();
    let tick = 0;
    const layers = [
      textLayer('one', () => `one-${tick}`),
      textLayer('two', () => `two-${tick}`, {
        slot: 110,
      }),
    ];
    const ctxA = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'first', ctxA, layers);
    tick = 1;
    const ctxB = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'second', ctxB, layers);

    const updates = textsAt(requests, 1).filter((t) => t.includes('<context_updates'));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('layer="one"');
    expect(updates[0]).toContain('layer="two"');
  });

  it('publishes nothing when no layer changed', async () => {
    const { harness, requests } = withCapture();
    const layers = [
      textLayer('steady', () => 'unchanging'),
    ];

    await runTurns(harness, layers, 3);

    for (const request of requests) {
      expect(texts(request.items).join('\n')).not.toContain('<context_updates');
    }
  });

  it('sends an explicit live layer after history', async () => {
    const { harness, requests } = withCapture();
    const layers = [
      textLayer('live-one', () => 'live-content', {
        placement: 'live',
      }),
    ];
    const ctx = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    ctx.itemLog.append(createMessage('older turn', 'user'));
    await executeCallModel(STEP, 'hi', ctx, layers);

    const seen = textsAt(requests, 0);
    expect(seen.indexOf('live-content')).toBeGreaterThan(seen.indexOf('older turn'));
  });

  it('sends an anchored layer before history', async () => {
    const { harness, requests } = withCapture();
    const layers = [
      textLayer('anchor-one', () => 'anchor-content', {
        placement: 'anchor',
      }),
    ];
    const ctx = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    ctx.itemLog.append(createMessage('older turn', 'user'));
    await executeCallModel(STEP, 'hi', ctx, layers);

    const seen = textsAt(requests, 0);
    expect(seen.indexOf('anchor-content')).toBeLessThan(seen.indexOf('older turn'));
  });

  it('never pins a layer whose recall changed state', async () => {
    const { harness, requests } = withCapture();
    let tick = 0;
    const draining: ContextLayer = {
      id: 'draining',
      slot: 90,
      scope: 'thread',
      hooks: {
        async recall() {
          const value = `drained-${tick++}`;
          return {
            items: [
              createMessage(value, 'developer'),
            ],
            tokenCount: 5,
            state: {
              seen: tick,
            },
          };
        },
      },
    };

    await runTurns(
      harness,
      [
        draining,
      ],
      2,
    );

    // Each turn shows its own render, never a replay of the first.
    expect(textsAt(requests, 0)).toContain('drained-0');
    expect(textsAt(requests, 1)).toContain('drained-1');
  });

  it('publishes a retraction when a pinned layer goes quiet', async () => {
    const { harness, requests } = withCapture();
    let quiet = false;
    const layers: ContextLayer[] = [
      {
        id: 'sometimes',
        slot: 100,
        scope: 'thread',
        hooks: {
          async recall() {
            return quiet ? null : 'present-content';
          },
        },
      },
    ];
    const ctxA = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'first', ctxA, layers);
    quiet = true;
    const ctxB = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'second', ctxB, layers);

    const second = textsAt(requests, 1).join('\n');
    expect(second).toContain('action="retract"');
    expect(second).toContain('layer="sometimes"');
  });

  it('prefers a layer-supplied compact supersede', async () => {
    const { harness, requests } = withCapture();
    let tick = 0;
    const layers: ContextLayer[] = [
      {
        id: 'compact',
        slot: 100,
        scope: 'thread',
        hooks: {
          async recall() {
            return `full-body-${tick++}`;
          },
          async renderDelta() {
            return 'just-the-change';
          },
        },
      },
    ];

    await runTurns(harness, layers, 2);

    const second = textsAt(requests, 1).join('\n');
    expect(second).toContain('just-the-change');
    expect(second).not.toContain('full-body-1');
  });

  it('republishes in full when renderDelta throws', async () => {
    const { harness, requests } = withCapture();
    let tick = 0;
    const layers: ContextLayer[] = [
      {
        id: 'broken',
        slot: 100,
        scope: 'thread',
        hooks: {
          async recall() {
            return `body-${tick++}`;
          },
          async renderDelta() {
            throw new Error('boom');
          },
        },
      },
    ];

    await runTurns(harness, layers, 2);

    expect(textsAt(requests, 1).join('\n')).toContain('body-1');
  });

  it('reports band, pin status and churn per layer', async () => {
    const { harness } = withCapture();
    let tick = 0;
    const layers = [
      textLayer('clock', () => `now: ${tick++}`),
    ];
    const ctxA = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'first', ctxA, layers);
    const ctxB = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'second', ctxB, layers);

    const usage = ctxB.lastLayerUsage;
    assert(usage !== undefined);
    const entry = usage.layers.find((l) => l.layerId === 'clock');
    assert(entry !== undefined);
    expect(entry.placement).toBe('anchor');
    expect(entry.served).toBe('pinned');
    expect(entry.changed).toBe(true);
    expect(entry.churnRate).toBeGreaterThan(0);
    expect(usage.epoch?.anchorTokens).toBeGreaterThan(0);
  });

  it('gives a child execution its own epoch', async () => {
    const { harness, requests } = withCapture();
    let tick = 0;
    const layers = [
      textLayer('clock', () => `now: ${tick++}`),
    ];
    const parent = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'parent', parent, layers);
    const child = new ContextImpl({
      harness,
      threadId: 'thread-1',
      parent,
    });
    await executeCallModel(STEP, 'child', child, layers);

    // The child anchors its own fresh render rather than replaying the parent's.
    expect(textsAt(requests, 1)).toContain('now: 1');
  });

  it('re-anchors when the instructions change', async () => {
    const { harness, requests } = withCapture();
    let tick = 0;
    const layers = [
      textLayer('clock', () => `now: ${tick++}`),
    ];
    const ctxA = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(
      {
        ...STEP,
        instructions: 'first prompt',
      },
      'a',
      ctxA,
      layers,
    );
    const ctxB = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(
      {
        ...STEP,
        instructions: 'a different prompt',
      },
      'b',
      ctxB,
      layers,
    );

    const second = textsAt(requests, 1);
    expect(second).toContain('now: 1');
    expect(second.join('\n')).not.toContain('<context_updates');
  });

  it('restores the pre-band layout when caching is switched off', async () => {
    const { harness, requests } = withCapture({
      contextCache: {
        enabled: false,
      },
    });
    let tick = 0;
    const layers = [
      textLayer('clock', () => `now: ${tick++}`, {
        placement: 'live',
      }),
    ];
    const ctx = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    ctx.itemLog.append(createMessage('older turn', 'user'));
    await executeCallModel(STEP, 'hi', ctx, layers);

    // Even an explicit live placement renders before history with caching off.
    const seen = textsAt(requests, 0);
    expect(seen.indexOf('now: 0')).toBeLessThan(seen.indexOf('older turn'));
  });

  it('recalls once across steering retries and counts the turn once', async () => {
    const { harness, requests } = withCapture();
    let recalls = 0;
    let guided = false;
    const layers: ContextLayer[] = [
      {
        id: 'counted',
        slot: 100,
        scope: 'thread',
        hooks: {
          async recall() {
            recalls++;
            return 'counted-body';
          },
        },
      },
    ];
    harness.afterModelCall = async () => {
      if (guided) {
        return {
          action: SteeringAction.Allow,
        };
      }
      guided = true;
      return {
        action: SteeringAction.Guide,
        guidance: 'try again please',
      };
    };
    const ctx = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'hi', ctx, layers);

    expect(recalls).toBe(1);
    expect(requests).toHaveLength(2);
  });

  it('puts steering guidance last, once', async () => {
    const { harness, requests } = withCapture();
    let guided = false;
    const layers = [
      textLayer('live-one', () => 'live-content', {
        placement: 'live',
      }),
    ];
    harness.afterModelCall = async () => {
      if (guided) {
        return {
          action: SteeringAction.Allow,
        };
      }
      guided = true;
      return {
        action: SteeringAction.Guide,
        guidance: 'try again please',
      };
    };
    const ctx = new ContextImpl({
      harness,
      threadId: 'thread-1',
    });
    await executeCallModel(STEP, 'hi', ctx, layers);

    const retry = textsAt(requests, 1);
    expect(retry.filter((t) => t === 'try again please')).toHaveLength(1);
    expect(retry[retry.length - 1]).toBe('try again please');
  });
});

describe('stampAnchoringAttributes', () => {
  function recordingSpan() {
    const attributes = new Map<string, string | number | boolean>();
    return {
      attributes,
      span: {
        traceId: 't',
        spanId: 's',
        parentSpanId: null,
        setAttribute(key: string, value: string | number | boolean) {
          attributes.set(key, value);
        },
        addEvent() {},
        end() {},
      },
    };
  }

  const view: BandedView = {
    anchorItems: [],
    liveItems: [],
    deltaItems: [],
    servedPerLayer: [],
    serveInfo: new Map([
      [
        'clock',
        {
          placement: 'live',
          served: 'fresh',
          changed: false,
          churnRate: 0.875,
          rebillTokens: 1_234.6,
        },
      ],
    ]),
    epoch: {
      id: 't:thread-1#2',
      age: 4,
      anchorTokens: 900,
      liveTokens: 30,
      deltaTokens: 12,
      reanchorReason: 'cache-miss',
    },
  };

  it('records the epoch and band sizes', () => {
    const { attributes, span } = recordingSpan();

    stampAnchoringAttributes(span, view);

    expect(attributes.get('noetic.context.epoch.id')).toBe('t:thread-1#2');
    expect(attributes.get('noetic.context.epoch.age')).toBe(4);
    expect(attributes.get('noetic.context.anchor_tokens')).toBe(900);
    expect(attributes.get('noetic.context.live_tokens')).toBe(30);
    expect(attributes.get('noetic.context.delta_tokens')).toBe(12);
    expect(attributes.get('noetic.context.reanchor_reason')).toBe('cache-miss');
  });

  it('records per-layer placement and churn as JSON', () => {
    const { attributes, span } = recordingSpan();

    stampAnchoringAttributes(span, view);

    const placements = attributes.get('noetic.context.layer_placements');
    const churn = attributes.get('noetic.context.layer_churn');
    assert(typeof placements === 'string' && typeof churn === 'string');
    expect(JSON.parse(placements)).toEqual([
      {
        id: 'clock',
        placement: 'live',
        served: 'fresh',
        changed: false,
      },
    ]);
    expect(JSON.parse(churn)).toEqual([
      {
        id: 'clock',
        rate: 0.875,
        rebillTokens: 1_235,
      },
    ]);
  });

  it('records nothing when caching is off', () => {
    const { attributes, span } = recordingSpan();

    stampAnchoringAttributes(span, {
      ...view,
      epoch: undefined,
    });

    expect(attributes.size).toBe(0);
  });
});
