import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { WorkflowDocument } from '@noetic-tools/core';
import { readPlanState } from '../lib/plan-state';

//#region Fixtures

const GOOD: WorkflowDocument = {
  version: 1,
  root: {
    kind: 'callModel',
    id: 'leaf',
    instructions: 'do the thing',
  },
};

function view(state: unknown) {
  const result = readPlanState(state);
  assert(typeof result !== 'string', `expected a plan, got "${result}"`);
  return result;
}

//#endregion

describe('readPlanState', () => {
  it('reads a well-formed plan', () => {
    const plan = view({
      phase: 'planning',
      planTree: GOOD,
      workflows: {
        verify: GOOD,
      },
    });

    expect(plan.phase).toBe('planning');
    expect(plan.planTree).toEqual(GOOD);
    expect(Object.keys(plan.workflows)).toEqual([
      'verify',
    ]);
    expect(plan.rejected).toEqual([]);
  });

  it('keeps the readable workflows when one is unreadable', () => {
    const plan = view({
      phase: 'planning',
      planTree: GOOD,
      workflows: {
        ok: GOOD,
        alsoOk: GOOD,
        bad: {
          version: 2,
          root: {},
        },
      },
    });

    // One bad entry costs you that entry. Discarding the collection would take
    // every subflow ref in the tree down with it.
    expect(Object.keys(plan.workflows).sort()).toEqual([
      'alsoOk',
      'ok',
    ]);
    expect(plan.rejected).toEqual([
      'bad',
    ]);
  });

  it('draws a plan whose tree is unreadable but whose workflows are not', () => {
    const plan = view({
      phase: 'planning',
      planTree: {
        version: 99,
      },
      workflows: {
        verify: GOOD,
      },
    });

    expect(plan.planTree).toBeNull();
    expect(Object.keys(plan.workflows)).toEqual([
      'verify',
    ]);
  });

  it('treats a missing phase as cosmetic, not fatal', () => {
    // `phase` is only a label; refusing to draw a whole plan over it would be
    // the strictest check guarding the least.
    const plan = view({
      planTree: GOOD,
    });

    expect(plan.phase).toBe('unknown');
    expect(plan.planTree).toEqual(GOOD);
  });

  it('separates "no plan yet" from "payload not recognised"', () => {
    // Nothing stored yet, or plan mode never entered.
    expect(readPlanState(null)).toBe('absent');
    expect(readPlanState(undefined)).toBe('absent');
    expect(
      readPlanState({
        phase: 'idle',
        planTree: null,
        workflows: {},
      }),
    ).toBe('absent');

    // Something arrived, but it is not plan state — a different problem, and
    // reporting it as "no plan yet" would hide a real failure.
    expect(readPlanState('a string')).toBe('unreadable');
    expect(readPlanState(42)).toBe('unreadable');
    expect(
      readPlanState({
        workflows: 'not a map',
      }),
    ).toBe('unreadable');
  });

  it('does not let a workflow named after an Object prototype member through', () => {
    const plan = view({
      phase: 'planning',
      planTree: GOOD,
      workflows: {
        toString: GOOD,
      },
    });

    // The name is legal as a key; what must not happen is a lookup falling
    // through to Object.prototype for names that were never stored.
    expect(Object.hasOwn(plan.workflows, 'toString')).toBe(true);
    expect(Object.hasOwn(plan.workflows, 'valueOf')).toBe(false);
  });
});
