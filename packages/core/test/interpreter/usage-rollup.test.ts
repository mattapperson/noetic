/**
 * Child-context usage roll-up (issue #109): every model call's tokens and
 * cost are charged to the calling context AND every ancestor on its
 * `usageParent` chain at the moment of spend — so a failed spawn child, a
 * fork path (any mode), an abandoned race loser, and a `createContext({ parent })`
 * child all reach the parent.
 */

import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData } from '@noetic-tools/context';
import type { CallModelRequest, Context, LLMResponse, Step } from '@noetic-tools/types';
import { isNoeticError, recordUsage, trackUsage } from '@noetic-tools/types';
import { inParallel } from '../../src/builders/control-flow-builders';
import { loop } from '../../src/builders/loop-builder';
import { spawn } from '../../src/builders/spawn-builder';
import { callModel, runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { ContextImpl } from '../../src/runtime/context-impl';
import { until } from '../../src/until/predicates';
import { makeLLMResponse, makeMockContext, makeMockHarness, sleep } from '../_helpers';

//#region Helper Functions

const CALL_COST = 0.01;

function billedResponse(): LLMResponse {
  return makeLLMResponse('ok', {
    usage: {
      inputTokens: 10,
      outputTokens: 5,
    },
    cost: CALL_COST,
  });
}

/** Harness whose every model call bills `CALL_COST`; per-step delays in ms. */
function makeHarness(delays: Record<string, number> = {}): AgentHarness {
  return new AgentHarness({
    name: 'usage-rollup',
    params: {},
    _testCallModel: async (request: CallModelRequest) => {
      const delay = request.nodeId ? delays[request.nodeId] : undefined;
      if (delay) {
        await sleep(delay);
      }
      return billedResponse();
    },
  });
}

function ask(id: string): Step<ContextData, string, string> {
  return callModel<ContextData, string, string>({
    id,
    model: 'test-model',
  });
}

/** One billed model call, then a throw — the shape that used to strand spend. */
function billThenFail(id: string): Step<ContextData, string, string> {
  return loop<ContextData, string, string>({
    id,
    steps: [
      ask(`${id}-ask`),
      runCode<ContextData, string, string>({
        id: `${id}-boom`,
        execute: async () => {
          throw new Error('child failed after spending');
        },
      }),
    ],
    until: until.maxSteps(1),
  });
}

async function expectRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected rejection');
}

function expectCalls(ctx: Context, calls: number): void {
  expect(ctx.cost).toBeCloseTo(calls * CALL_COST, 10);
  expect(ctx.tokens.input).toBe(calls * 10);
  expect(ctx.tokens.output).toBe(calls * 5);
  expect(ctx.tokens.total).toBe(calls * 15);
}

//#endregion

//#region recordUsage

describe('recordUsage', () => {
  it('charges the context and every ancestor', () => {
    const harness = makeMockHarness();
    const root = new ContextImpl({
      harness,
    });
    const mid = new ContextImpl({
      harness,
      parent: root,
    });
    const leaf = new ContextImpl({
      harness,
      parent: mid,
    });

    recordUsage(leaf, {
      inputTokens: 3,
      outputTokens: 2,
      cachedTokens: 1,
      cost: 0.5,
    });

    for (const ctx of [
      leaf,
      mid,
      root,
    ]) {
      expect(ctx.tokens).toEqual({
        input: 3,
        output: 2,
        total: 5,
        cached: 1,
      });
      expect(ctx.cost).toBe(0.5);
    }
  });

  it('stops at a context created with rollUpUsage: false', () => {
    const harness = makeMockHarness();
    const root = new ContextImpl({
      harness,
    });
    const isolated = new ContextImpl({
      harness,
      parent: root,
      rollUpUsage: false,
    });

    trackUsage(isolated, billedResponse());

    expect(isolated.usageParent).toBeNull();
    expect(isolated.parent).toBe(root);
    expectCalls(isolated, 1);
    expectCalls(root, 0);
  });

  it('leaves `cached` undefined on every ancestor when the charge reports none', () => {
    const harness = makeMockHarness();
    const root = new ContextImpl({
      harness,
    });
    const child = new ContextImpl({
      harness,
      parent: root,
    });

    trackUsage(child, billedResponse());

    expect(child.tokens.cached).toBeUndefined();
    expect(root.tokens.cached).toBeUndefined();
  });

  it('falls back to `parent` when a context has no `usageParent`, and survives a cycle', () => {
    const root = new ContextImpl({
      harness: makeMockHarness(),
    });
    // Hand-rolled Contexts: no `usageParent`, and a writable own `stepCount`
    // so they are treated as usage-mutable.
    const custom = makeMockContext({
      parent: root,
    });
    const looped = makeMockContext();
    Object.defineProperty(looped, 'parent', {
      value: looped,
    });

    recordUsage(custom, {
      inputTokens: 1,
      outputTokens: 1,
      cost: 0.1,
    });
    recordUsage(looped, {
      inputTokens: 1,
      outputTokens: 1,
    });

    expect(custom.cost).toBe(0.1);
    expect(root.cost).toBe(0.1);
    expect(looped.tokens.total).toBe(2);
  });
});

//#endregion

//#region spawn

describe('spawn usage roll-up', () => {
  it('charges the parent for a child that succeeds', async () => {
    const harness = makeHarness();
    const ctx = harness.createContext();

    await harness.run(
      spawn<ContextData, string, string>({
        id: 'child',
        child: ask('child-ask'),
      }),
      'hi',
      ctx,
    );

    expectCalls(ctx, 1);
  });

  it('charges the parent for a child that throws after spending', async () => {
    const harness = makeHarness();
    const ctx = harness.createContext();

    const error = await expectRejection(
      harness.run(
        spawn<ContextData, string, string>({
          id: 'child',
          child: billThenFail('failing'),
        }),
        'hi',
        ctx,
      ),
    );

    expect(isNoeticError(error)).toBe(true);
    expectCalls(ctx, 1);
  });

  it('counts each call exactly once through spawn → inParallel → spawn', async () => {
    const harness = makeHarness();
    const ctx = harness.createContext();
    const seen: Context[] = [];
    const recordCtx = (id: string) =>
      runCode<ContextData, string, string>({
        id,
        execute: async (input, c) => {
          seen.push(c);
          return input;
        },
      });

    const inner = (id: string) =>
      spawn<ContextData, string, string>({
        id,
        child: loop<ContextData, string, string>({
          id: `${id}-body`,
          steps: [
            ask(`${id}-ask`),
            recordCtx(`${id}-rec`),
          ],
          until: until.maxSteps(1),
        }),
      });

    await harness.run(
      spawn<ContextData, string, string>({
        id: 'outer',
        child: inParallel<ContextData, string, string>({
          id: 'fan',
          mode: 'all',
          paths: () => [
            inner('a'),
            inner('b'),
          ],
          merge: (r) => r.join(' '),
        }),
      }),
      'hi',
      ctx,
    );

    // Root: 2 calls. Each innermost spawn child: its own 1 call. Each fork
    // path (the inner spawn's parent): 1. The outer spawn child: 2.
    expectCalls(ctx, 2);
    expect(seen).toHaveLength(2);
    for (const leaf of seen) {
      expectCalls(leaf, 1);
      assert(leaf.parent);
      expectCalls(leaf.parent, 1);
      assert(leaf.parent.parent);
      expectCalls(leaf.parent.parent, 2);
    }
  });
});

//#endregion

//#region inParallel

describe('inParallel usage roll-up', () => {
  it("mode 'all': charges the parent for every path, including the one that failed", async () => {
    const harness = makeHarness({
      'ok-ask': 0,
    });
    const ctx = harness.createContext();

    const error = await expectRejection(
      harness.run(
        inParallel<ContextData, string, string>({
          id: 'fan',
          mode: 'all',
          paths: () => [
            ask('ok-ask'),
            billThenFail('bad'),
          ],
          merge: (r) => r.join(' '),
        }),
        'hi',
        ctx,
      ),
    );

    assert(isNoeticError(error));
    expect(error.noeticError.kind).toBe('fork_partial');
    expectCalls(ctx, 2);
  });

  it("mode 'all': charges the parent for every path on success", async () => {
    const harness = makeHarness();
    const ctx = harness.createContext();

    const result = await harness.run(
      inParallel<ContextData, string, string>({
        id: 'fan',
        mode: 'all',
        paths: () => [
          ask('a'),
          ask('b'),
        ],
        merge: (r) => r.join(' '),
      }),
      'hi',
      ctx,
    );

    expect(result).toBe('ok ok');
    expectCalls(ctx, 2);
  });

  it("mode 'settle': charges the parent for fulfilled and rejected paths", async () => {
    const harness = makeHarness();
    const ctx = harness.createContext();

    const result = await harness.run(
      inParallel<ContextData, string, string>({
        id: 'fan',
        mode: 'settle',
        paths: () => [
          ask('a'),
          billThenFail('bad'),
        ],
        merge: (r) => r.map((s) => s.status).join(','),
      }),
      'hi',
      ctx,
    );

    expect(result).toBe('fulfilled,rejected');
    expectCalls(ctx, 2);
  });

  it("mode 'race': a loser whose call lands after the winner still charges the parent", async () => {
    const harness = makeHarness({
      fast: 0,
      slow: 30,
    });
    const ctx = harness.createContext();

    const result = await harness.run(
      inParallel<ContextData, string, string>({
        id: 'race',
        mode: 'race',
        paths: () => [
          ask('fast'),
          ask('slow'),
        ],
      }),
      'hi',
      ctx,
    );

    expect(result).toBe('ok');
    expectCalls(ctx, 1);

    await sleep(60);
    expectCalls(ctx, 2);
  });

  it("mode 'race': charges the parent for a path that failed before the winner", async () => {
    const harness = makeHarness({
      'bad-ask': 0,
      winner: 20,
    });
    const ctx = harness.createContext();

    await harness.run(
      inParallel<ContextData, string, string>({
        id: 'race',
        mode: 'race',
        paths: () => [
          billThenFail('bad'),
          ask('winner'),
        ],
      }),
      'hi',
      ctx,
    );

    expectCalls(ctx, 2);
  });

  it('until.maxCost on an enclosing loop sees spend from parallel paths', async () => {
    const harness = makeHarness();
    const ctx = harness.createContext();
    let iterations = 0;

    await harness.run(
      loop<ContextData, string, string>({
        id: 'budgeted',
        steps: [
          inParallel<ContextData, string, string>({
            id: 'fan',
            mode: 'all',
            paths: () => {
              iterations++;
              return [
                ask('a'),
                ask('b'),
              ];
            },
            merge: (r) => r.join(' '),
          }),
        ],
        // Two calls per iteration at CALL_COST each: the cap is crossed on
        // the second iteration, so the loop must stop there.
        until: until.maxCost(CALL_COST * 3),
        maxIterations: 10,
      }),
      'hi',
      ctx,
    );

    expect(iterations).toBe(2);
    expectCalls(ctx, 4);
  });
});

//#endregion

//#region createContext / detachedSpawn

describe('createContext({ parent }) usage roll-up', () => {
  it('charges the parent by default', async () => {
    const harness = makeHarness();
    const parent = harness.createContext();
    const child = harness.createContext({
      parent,
    });

    await harness.run(ask('a'), 'hi', child);

    expectCalls(child, 1);
    expectCalls(parent, 1);
  });

  it('does not double-count when the same child context runs twice', async () => {
    const harness = makeHarness();
    const parent = harness.createContext();
    const child = harness.createContext({
      parent,
    });

    await harness.run(ask('a'), 'hi', child);
    await harness.run(ask('b'), 'hi', child);

    expectCalls(child, 2);
    expectCalls(parent, 2);
  });

  it('keeps spend off the parent with rollUpUsage: false', async () => {
    const harness = makeHarness();
    const parent = harness.createContext();
    const child = harness.createContext({
      parent,
      rollUpUsage: false,
    });

    await harness.run(ask('a'), 'hi', child);

    expectCalls(child, 1);
    expectCalls(parent, 0);
  });

  it('detachedSpawn (in-process) charges the parent context', async () => {
    const harness = makeHarness();
    const parent = harness.createContext();

    const handle = harness.detachedSpawn(ask('a'), 'hi', parent);
    await handle.await();

    expectCalls(parent, 1);
  });
});

//#endregion
