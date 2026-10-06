/**
 * Two things a session's identity has to get right, both of which the shared
 * session log / warm-hydration optimisations quietly got wrong:
 *
 *  1. WHAT the shared log accepts. Every turn's context validates items against
 *     the harness base registry EXTENDED with its context layers' `itemSchemas`,
 *     but the session-owned log is created once per thread. Bind it to the base
 *     registry and every item type a layer declares is rejected — on the seeding
 *     path (`seedSessionHistory`, which the chat host calls on first contact for
 *     every thread) and mid-turn alike. The seeding failure is caught and logged
 *     upstream, so the symptom is not a crash but a thread that silently loses
 *     its history on every message, forever.
 *
 *  2. WHICH bucket a warm turn inherits. Layer state lives under
 *     `resolveScopeKey(layer.scope, ctx)`, and for 'resource' and 'global' scope
 *     that key is not a function of the thread. Keying warm carry-forward on
 *     threadId alone therefore hands one bucket's state to a turn addressing a
 *     different one — and because write-through is then re-pointed at the NEW
 *     scope key, the mismatch is persisted rather than staying in memory.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData, ContextLayer, StorageAdapter } from '@noetic-tools/context';
import type { Item, LLMResponse, MessageItem, Step } from '@noetic-tools/types';
import { frameworkCast } from '@noetic-tools/types';
import { z } from 'zod';
import { AgentHarness } from '../../src/harness/agent-harness';
import { assistantMessage, makeStorage } from '../_helpers';

//#region Helpers

/** A custom item type contributed by a layer, not known to the base registry. */
const NoteItemSchema = z.object({
  type: z.literal('myapp:note'),
  id: z.string(),
  note: z.string(),
});

/**
 * A custom item, shaped by the layer's own schema. `frameworkCast` is the seam a
 * host crosses when handing its own declared item type to the framework: the
 * registry is a shape GATE rather than a normalizer, so the item travels through
 * the log as authored and `Item` cannot enumerate every extension type.
 */
function noteItem(id: string, note: string): Item {
  return frameworkCast<Item>(
    NoteItemSchema.parse({
      type: 'myapp:note',
      id,
      note,
    }),
  );
}

/** An item whose type NO configured layer declares. */
function undeclaredItem(): Item {
  return frameworkCast<Item>({
    type: 'myapp:unknown',
    id: 'u1',
  });
}

/** A layer that declares `myapp:note` as an item type. */
function noteDeclaringLayer(): ContextLayer {
  return {
    id: 'notes',
    slot: 100,
    scope: 'thread',
    itemSchemas: {
      items: [
        NoteItemSchema,
      ],
    },
    hooks: {
      async recall() {
        return 'notes layer';
      },
    },
  };
}

const chatStep: Step<ContextData, string, string> = {
  kind: 'callModel',
  id: 'chat',
  model: 'test/scripted',
  tools: [],
};

function harnessWith(opts: { layers?: ContextLayer[]; storage?: StorageAdapter }): AgentHarness {
  let call = 0;
  return new AgentHarness({
    name: 'session-identity',
    params: {},
    agentGraph: chatStep,
    environment: {
      storage: {
        adapter: opts.storage ?? makeStorage(),
      },
    },
    contextLayers: opts.layers,
    _testCallModel: async (): Promise<LLMResponse> => {
      const message: MessageItem = assistantMessage(`answer ${call}`, `resp-${call}`);
      call += 1;
      return {
        items: [
          message,
        ],
        usage: {
          inputTokens: 0,
          outputTokens: 1,
        },
      };
    },
  });
}

interface SeenState {
  seen: string[];
}

/**
 * A layer at `scope` that records, in its own state, every event it saw — so a
 * leak across scope boundaries is visible as one bucket's state containing
 * another's marks. `tag` is whatever the current turn calls itself.
 */
function seenLayer(
  scope: 'resource' | 'global' | 'thread',
  tag: () => string,
): {
  layer: ContextLayer<SeenState>;
  inits: () => number;
} {
  let inits = 0;
  const layer: ContextLayer<SeenState> = {
    id: 'seen',
    slot: 100,
    scope,
    hooks: {
      async init({ storage }) {
        inits += 1;
        const saved = await storage.get<SeenState>('state');
        return {
          state: saved ?? {
            seen: [
              `init@${tag()}`,
            ],
          },
        };
      },
      async recall({ state }) {
        return `seen=${state.seen.join(',')}`;
      },
      async store({ state }) {
        return {
          state: {
            seen: [
              ...(state?.seen ?? []),
              `store@${tag()}`,
            ],
          },
        };
      },
    },
  };
  return {
    layer,
    inits: () => inits,
  };
}

async function runTurn(
  harness: AgentHarness,
  scope: {
    threadId: string;
    resourceId?: string;
  },
  text: string,
): Promise<void> {
  await harness.execute(text, scope);
  await harness.getAgentResponse({
    threadId: scope.threadId,
  });
}

/** A layer's persisted state for one scope bucket, straight out of storage. */
async function persistedState(
  storage: StorageAdapter,
  layerId: string,
  scopeKey: string,
): Promise<SeenState | null> {
  return storage.get<SeenState>(`layers/${layerId}/${scopeKey}/state`);
}

//#endregion

describe('the session-owned log honours the layers item registry', () => {
  it('seedSessionHistory accepts an item type a context layer declares', async () => {
    const harness = harnessWith({
      layers: [
        noteDeclaringLayer(),
      ],
    });
    // Bound to the BASE registry this throws `item_schema_mismatch` from inside
    // `seedSessionHistory` — swallowed by the caller upstream, so a thread's
    // history vanishes silently on every message instead of failing loudly.
    harness.seedSessionHistory('seeded', [
      noteItem('n1', 'remembered'),
    ]);

    const items = await harness.previewRequestItems({
      threadId: 'seeded',
    });
    expect(items.map((i) => i.type)).toContain('myapp:note');
  });

  it('a layer-declared item survives a full turn on the shared log', async () => {
    const harness = harnessWith({
      layers: [
        noteDeclaringLayer(),
      ],
    });
    harness.seedSessionHistory('turning', [
      noteItem('n1', 'before the turn'),
    ]);
    await runTurn(
      harness,
      {
        threadId: 'turning',
      },
      'hello',
    );

    const types = (
      await harness.previewRequestItems({
        threadId: 'turning',
      })
    ).map((i) => i.type);
    // The custom item is still there, and the turn's own items landed alongside it.
    expect(types).toContain('myapp:note');
    expect(types).toContain('message');
  });

  it('an item type NO layer declares is still rejected', () => {
    // The fix widens the log to the layers' registry — it must not widen it to
    // anything, or `strictItemSchemas` would stop meaning anything on this path.
    const harness = harnessWith({
      layers: [
        noteDeclaringLayer(),
      ],
    });
    expect(() =>
      harness.seedSessionHistory('rejecting', [
        undeclaredItem(),
      ]),
    ).toThrow(/myapp:unknown/);
  });

  it('a harness with no layers still rejects an undeclared type', () => {
    const harness = harnessWith({});
    expect(() =>
      harness.seedSessionHistory('bare', [
        noteItem('n1', 'nobody declared me'),
      ]),
    ).toThrow(/myapp:note/);
  });
});

describe('warm hydration respects each layers resolved scope key', () => {
  it('a resource-scoped layer cold-inits when resourceId changes (no cross-tenant leak)', async () => {
    /* The verified cross-tenant repro: one resource-scoped layer, one thread,
     * turn 1 as 'alice' and turn 2 as 'bob'. Keyed on threadId alone, bob's turn
     * took the warm path and inherited alice's state — then
     * `registerDurableTargets` re-pointed write-through at scopeKey 'bob', so
     * storage ended with bob's bucket holding alice's marks. */
    const storage = makeStorage();
    let tag = 'alice';
    const probe = seenLayer('resource', () => tag);
    const harness = harnessWith({
      layers: [
        probe.layer,
      ],
      storage,
    });

    await runTurn(
      harness,
      {
        threadId: 'shared',
        resourceId: 'alice',
      },
      'from alice',
    );
    tag = 'bob';
    await runTurn(
      harness,
      {
        threadId: 'shared',
        resourceId: 'bob',
      },
      'from bob',
    );

    // Two buckets, each holding only its own marks.
    const alice = await persistedState(storage, 'seen', 'alice');
    const bob = await persistedState(storage, 'seen', 'bob');
    assert(alice);
    assert(bob);
    expect(alice.seen).toEqual([
      'init@alice',
      'store@alice',
    ]);
    expect(bob.seen).toEqual([
      'init@bob',
      'store@bob',
    ]);
    // Explicitly: nothing of alice's reached bob's persisted record.
    expect(bob.seen.some((s) => s.includes('alice'))).toBe(false);
    // Bob's turn had to cold-init to read his own (empty) bucket.
    expect(probe.inits()).toBe(2);
  });

  it('the same resourceId still warm-carries (the fix is not a blanket cold-init)', async () => {
    const storage = makeStorage();
    const probe = seenLayer('resource', () => 'alice');
    const harness = harnessWith({
      layers: [
        probe.layer,
      ],
      storage,
    });

    for (const text of [
      'one',
      'two',
      'three',
    ]) {
      await runTurn(
        harness,
        {
          threadId: 'shared',
          resourceId: 'alice',
        },
        text,
      );
    }

    // One cold init for three turns — the whole point of the warm path.
    expect(probe.inits()).toBe(1);
    const alice = await persistedState(storage, 'seen', 'alice');
    assert(alice);
    // ...and state accumulated across them rather than resetting each turn.
    expect(alice.seen.filter((s) => s.startsWith('store@'))).toHaveLength(3);
  });

  it('a resource-scoped layer returning to an earlier resourceId re-reads that bucket', async () => {
    // alice → bob → alice. The final turn must resume ALICE's accumulated state,
    // not bob's, and not a fresh init that discards hers.
    const storage = makeStorage();
    let tag = 'alice';
    const probe = seenLayer('resource', () => tag);
    const harness = harnessWith({
      layers: [
        probe.layer,
      ],
      storage,
    });

    await runTurn(
      harness,
      {
        threadId: 'shared',
        resourceId: 'alice',
      },
      'a1',
    );
    tag = 'bob';
    await runTurn(
      harness,
      {
        threadId: 'shared',
        resourceId: 'bob',
      },
      'b1',
    );
    tag = 'alice';
    await runTurn(
      harness,
      {
        threadId: 'shared',
        resourceId: 'alice',
      },
      'a2',
    );

    const alice = await persistedState(storage, 'seen', 'alice');
    const bob = await persistedState(storage, 'seen', 'bob');
    assert(alice);
    assert(bob);
    // Alice's two turns both stored; her bucket never saw bob.
    expect(alice.seen.filter((s) => s === 'store@alice')).toHaveLength(2);
    expect(alice.seen.some((s) => s.includes('bob'))).toBe(false);
    expect(bob.seen.some((s) => s.includes('alice'))).toBe(false);
  });

  it('a global-scoped layer does not lose another threads update', async () => {
    /* The verified lost-update repro: a global-scoped counter, thread A for three
     * turns, thread B for one, then thread A again. A's warm entry held an
     * in-memory copy predating B's increment, and the write-through mirror made
     * that stale value win — turning a shared global bucket into a silent
     * last-writer-wins race between threads. */
    const storage = makeStorage();
    let tag = 'A';
    const probe = seenLayer('global', () => tag);
    const harness = harnessWith({
      layers: [
        probe.layer,
      ],
      storage,
    });

    for (const text of [
      'a1',
      'a2',
      'a3',
    ]) {
      await runTurn(
        harness,
        {
          threadId: 'A',
        },
        text,
      );
    }
    tag = 'B';
    await runTurn(
      harness,
      {
        threadId: 'B',
      },
      'b1',
    );
    tag = 'A';
    await runTurn(
      harness,
      {
        threadId: 'A',
      },
      'a4',
    );

    const global = await persistedState(storage, 'seen', '__global__');
    assert(global);
    // Five turns stored into the one shared bucket; none of them lost. The bug
    // dropped B's, leaving four.
    expect(global.seen.filter((s) => s.startsWith('store@'))).toHaveLength(5);
    expect(global.seen).toContain('store@B');
  });

  it('a thread-scoped layer still warm-carries across turns (regression guard)', async () => {
    // 'thread' is the scope where threadId happens to BE the scope key, so the
    // pre-fix behaviour was already correct here. It must stay correct: the fix
    // narrows carry-forward, and narrowing it too far would silently reintroduce
    // a cold storage read per turn per layer.
    const storage = makeStorage();
    const probe = seenLayer('thread', () => 'T');
    const harness = harnessWith({
      layers: [
        probe.layer,
      ],
      storage,
    });

    for (const text of [
      'one',
      'two',
      'three',
    ]) {
      await runTurn(
        harness,
        {
          threadId: 'T',
        },
        text,
      );
    }

    expect(probe.inits()).toBe(1);
    const state = await persistedState(storage, 'seen', 'T');
    assert(state);
    expect(state.seen.filter((s) => s.startsWith('store@'))).toHaveLength(3);
  });

  it('a resource-scoped layer with no resourceId falls back to the thread bucket', async () => {
    // `resolveScopeKey('resource', ctx)` is `resourceId ?? threadId`, so turns
    // without a resourceId all address the thread bucket and must warm-carry.
    const storage = makeStorage();
    const probe = seenLayer('resource', () => 'T');
    const harness = harnessWith({
      layers: [
        probe.layer,
      ],
      storage,
    });

    await runTurn(
      harness,
      {
        threadId: 'T',
      },
      'one',
    );
    await runTurn(
      harness,
      {
        threadId: 'T',
      },
      'two',
    );

    expect(probe.inits()).toBe(1);
    const state = await persistedState(storage, 'seen', 'T');
    assert(state);
    expect(state.seen.filter((s) => s.startsWith('store@'))).toHaveLength(2);
  });
});
