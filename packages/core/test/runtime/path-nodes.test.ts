// Execution paths are built lazily from a tree of PathNodes, and the dispatch counts
// beneath a finished step are dropped. See ContextImpl.enterStep / leaveStep.

import { describe, expect, it } from 'bun:test';
import type { ContextData } from '@noetic-tools/types';
import { runCode } from '../../src/builders/step-builders';
import { AgentHarness } from '../../src/harness/agent-harness';
import { ContextImpl, PathNode } from '../../src/runtime/context-impl';

function harness(): AgentHarness {
  return new AgentHarness({
    name: 'path-nodes',
    params: {},
  });
}

function rootContext(): ContextImpl {
  const ctx = harness().createContext();
  assertContextImpl(ctx);
  return ctx;
}

function frame(stepId: string): {
  stepId: string;
  input: unknown;
} {
  return {
    stepId,
    input: null,
  };
}

describe('PathNode', () => {
  it('joins the parent path and its own segment', () => {
    const root = new PathNode(undefined, '[2]');
    const child = new PathNode(root, '/a#0');
    const grandchild = new PathNode(child, '/b#3');
    expect(grandchild.path).toBe('[2]/a#0/b#3');
    expect(root.path).toBe('[2]');
  });

  it('starts with no counts', () => {
    expect(new PathNode(undefined, '').counts.size).toBe(0);
  });
});

describe('ContextImpl path tree', () => {
  it('numbers repeat dispatches of one step id under the same parent', () => {
    const ctx = rootContext();
    expect(ctx.enterStep(frame('a')).currentPath()).toBe('/a#0');
    expect(ctx.enterStep(frame('a')).currentPath()).toBe('/a#1');
    const lane = ctx.enterStep(frame('b'));
    expect(lane.enterStep(frame('c')).currentPath()).toBe('/b#0/c#0');
  });

  it('branchPath hangs a child context under the lane path', () => {
    const ctx = rootContext();
    const lane = ctx.enterStep(frame('fork'));
    const child = new ContextImpl({
      harness: ctx.harness,
      parent: ctx,
      path: lane.branchPath('[1]'),
    });
    expect(child.enterStep(frame('leaf')).currentPath()).toBe('/fork#0[1]/leaf#0');
  });

  it('drops the counts beneath a finished step but keeps its own', () => {
    const ctx = rootContext();
    const outer = frame('outer');
    const lane = ctx.enterStep(outer);
    lane.enterStep(frame('inner'));
    lane.enterStep(frame('inner'));
    expect(ctx.runBaseline().occurrences).toEqual({
      '/outer': 1,
      '/outer#0/inner': 2,
    });

    lane.leaveStep(outer);
    expect(ctx.runBaseline().occurrences).toEqual({
      '/outer': 1,
    });
    expect(ctx.enterStep(frame('outer')).currentPath()).toBe('/outer#1');
  });

  it('keeps only top-level counts after a run with nested dispatches', async () => {
    const h = harness();
    const ctx = h.createContext();
    assertContextImpl(ctx);
    const leaf = runCode<ContextData, string, string>({
      id: 'leaf',
      execute: async (input: string) => `${input}!`,
    });
    const parent = runCode<ContextData, string, string>({
      id: 'parent',
      execute: async (input: string, execCtx) => {
        let out = input;
        for (let i = 0; i < 3; i++) {
          out = String(await h.run(leaf, out, execCtx));
        }
        return out;
      },
    });
    expect(await h.run(parent, 'x', ctx)).toBe('x!!!');
    expect(ctx.runBaseline().occurrences).toEqual({
      '/parent': 1,
    });
  });

  it('takes restored counts on first use, at any depth', () => {
    const ctx = rootContext();
    ctx.restoreOccurrences({
      '/a': 2,
      '/a#2/b': 5,
    });
    const lane = ctx.enterStep(frame('a'));
    expect(lane.currentPath()).toBe('/a#2');
    expect(lane.enterStep(frame('b')).currentPath()).toBe('/a#2/b#5');
    expect(ctx.runBaseline().occurrences).toEqual({
      '/a': 3,
      '/a#2/b': 6,
    });
  });

  it('lists restored counts no dispatch has taken yet', () => {
    const ctx = rootContext();
    ctx.restoreOccurrences({
      '/untouched': 4,
    });
    ctx.enterStep(frame('other'));
    expect(ctx.runBaseline().occurrences).toEqual({
      '/untouched': 4,
      '/other': 1,
    });
  });

  it('releaseDispatch gives the ordinal back and drops restored counts beneath it', () => {
    const ctx = rootContext();
    ctx.restoreOccurrences({
      '/a#0/deep': 7,
    });
    const lane = ctx.enterStep(frame('a'));
    lane.enterStep(frame('inner'));
    lane.releaseDispatch();
    expect(ctx.runBaseline().occurrences).toEqual({
      '/a': 0,
    });
    const retry = ctx.enterStep(frame('a'));
    expect(retry.currentPath()).toBe('/a#0');
    expect(retry.enterStep(frame('deep')).currentPath()).toBe('/a#0/deep#0');
  });

  it('rebase replaces every live and restored count with the baseline', () => {
    const ctx = rootContext();
    ctx.restoreOccurrences({
      '/stale': 9,
    });
    ctx.enterStep(frame('a'));
    ctx.rebase({
      items: [],
      occurrences: {
        '/a': 4,
      },
    });
    expect(ctx.runBaseline().occurrences).toEqual({
      '/a': 4,
    });
    expect(ctx.enterStep(frame('a')).currentPath()).toBe('/a#4');
  });
});

function assertContextImpl(ctx: unknown): asserts ctx is ContextImpl {
  if (!(ctx instanceof ContextImpl)) {
    throw new Error('expected a ContextImpl');
  }
}
