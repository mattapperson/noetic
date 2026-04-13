/**
 * Tests for buildIterationGroups from ChildrenList
 */

import { describe, expect, it } from 'bun:test';
import { buildIterationGroups } from '../../../../src/client/components/inspector/ChildrenList';
import type { ExecutionNode } from '../../../../src/client/types';

//#region Helpers

const ZERO_SNAPSHOT = {
  depth: 0,
  stepCount: 0,
  tokens: {
    input: 0,
    output: 0,
    total: 0,
  },
  cost: 0,
  elapsedMs: 0,
  state: null,
  itemLogLength: 0,
};

function makeNode(id: string, overrides: Partial<ExecutionNode> = {}): ExecutionNode {
  return {
    id,
    stepId: `step-${id}`,
    kind: 'run',
    parentId: null,
    depth: 0,
    startTime: 1000,
    endTime: 1100,
    durationMs: 100,
    status: 'completed',
    input: null,
    output: null,
    contextSnapshot: {
      ...ZERO_SNAPSHOT,
    },
    stepData: {
      description: '',
    },
    children: [],
    ...overrides,
  };
}

//#endregion

describe('buildIterationGroups', () => {
  it('returns empty array when totalIterations is 0', () => {
    const children = [
      makeNode('a'),
      makeNode('b'),
    ];
    const result = buildIterationGroups(children, 0);
    expect(result).toEqual([]);
  });

  it('returns empty array when totalIterations is negative', () => {
    const children = [
      makeNode('a'),
    ];
    const result = buildIterationGroups(children, -1);
    expect(result).toEqual([]);
  });

  it('returns empty array when children is empty', () => {
    const result = buildIterationGroups([], 3);
    expect(result).toEqual([]);
  });

  it('single iteration puts all children in one group', () => {
    const children = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c'),
    ];
    const result = buildIterationGroups(children, 1);

    expect(result).toHaveLength(1);
    expect(result[0].iteration).toBe(1);
    expect(result[0].children).toHaveLength(3);
    expect(result[0].children[0].id).toBe('a');
    expect(result[0].children[1].id).toBe('b');
    expect(result[0].children[2].id).toBe('c');
  });

  it('groups children evenly by totalIterations', () => {
    const children = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c'),
      makeNode('d'),
      makeNode('e'),
      makeNode('f'),
    ];
    const result = buildIterationGroups(children, 3);

    expect(result).toHaveLength(3);
    expect(result[0].iteration).toBe(1);
    expect(result[0].children).toHaveLength(2);
    expect(result[1].iteration).toBe(2);
    expect(result[1].children).toHaveLength(2);
    expect(result[2].iteration).toBe(3);
    expect(result[2].children).toHaveLength(2);
  });

  it('remainder children go to the last group', () => {
    const children = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c'),
      makeNode('d'),
      makeNode('e'),
    ];
    // 5 children / 2 iterations => groupSize=2, last group gets remainder
    const result = buildIterationGroups(children, 2);

    expect(result).toHaveLength(2);
    expect(result[0].children).toHaveLength(2);
    expect(result[0].children[0].id).toBe('a');
    expect(result[0].children[1].id).toBe('b');
    // Last group gets 3 (the remainder)
    expect(result[1].children).toHaveLength(3);
    expect(result[1].children[0].id).toBe('c');
    expect(result[1].children[1].id).toBe('d');
    expect(result[1].children[2].id).toBe('e');
  });

  it('more iterations than children puts all in a single group', () => {
    const children = [
      makeNode('a'),
      makeNode('b'),
    ];
    // 2 children / 5 iterations => groupSize = 0 => single group with all children
    const result = buildIterationGroups(children, 5);

    expect(result).toHaveLength(1);
    expect(result[0].iteration).toBe(1);
    expect(result[0].children).toHaveLength(2);
  });

  it('preserves child order within groups', () => {
    const children = [
      makeNode('x'),
      makeNode('y'),
      makeNode('z'),
      makeNode('w'),
    ];
    const result = buildIterationGroups(children, 2);

    expect(result[0].children[0].id).toBe('x');
    expect(result[0].children[1].id).toBe('y');
    expect(result[1].children[0].id).toBe('z');
    expect(result[1].children[1].id).toBe('w');
  });

  it('iteration numbers are 1-indexed', () => {
    const children = [
      makeNode('a'),
      makeNode('b'),
      makeNode('c'),
    ];
    const result = buildIterationGroups(children, 3);

    expect(result[0].iteration).toBe(1);
    expect(result[1].iteration).toBe(2);
    expect(result[2].iteration).toBe(3);
  });
});
