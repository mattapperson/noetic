/**
 * Integration test: verifies that the layout algorithm correctly handles
 * container nodes (loop, fork, branch, spawn) that contain child steps,
 * and leaf nodes that stand alone.
 */

import { describe, expect, it } from 'bun:test';
import { calculateSequentialLayout } from '../src/client/lib/sequential-layout';
import type { ExecutionNode } from '../src/client/types';

const ZERO_SNAPSHOT = {
  depth: 0,
  stepCount: 0,
  tokens: { input: 0, output: 0, total: 0 },
  cost: 0,
  elapsedMs: 0,
  state: null,
  itemLogLength: 0,
};

function makeNode(
  id: string,
  opts: { parentId?: string | null; kind?: ExecutionNode['kind']; depth?: number; startTime?: number } = {},
): ExecutionNode {
  return {
    id,
    stepId: id,
    kind: opts.kind ?? 'run',
    parentId: opts.parentId ?? null,
    depth: opts.depth ?? 0,
    startTime: opts.startTime ?? Date.now(),
    endTime: null,
    durationMs: null,
    status: 'completed',
    input: {},
    output: null,
    contextSnapshot: { ...ZERO_SNAPSHOT, depth: opts.depth ?? 0 },
    stepData: { description: '' } as ExecutionNode['stepData'],
    children: [],
  };
}

describe('node rendering integration', () => {
  it('renders leaf nodes sequentially when siblings of a container', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('branch', makeNode('branch', { kind: 'branch', depth: 0, startTime: 1000 }));
    nodes.set('step-1', makeNode('step-1', { parentId: 'branch', kind: 'run', depth: 1, startTime: 2000 }));
    nodes.set('step-2', makeNode('step-2', { parentId: 'branch', kind: 'llm', depth: 1, startTime: 3000 }));

    const { positions } = calculateSequentialLayout(nodes, 'branch');

    // branch (container) + 2 leaf children
    expect(positions).toHaveLength(3);
    const step1 = positions.find((p) => p.id === 'step-1');
    const step2 = positions.find((p) => p.id === 'step-2');
    expect(step1).toBeDefined();
    expect(step2).toBeDefined();
    // Second node should be below the first
    expect(step2!.y).toBeGreaterThan(step1!.y);
  });

  it('renders loop as container with children inside', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('loop-1', makeNode('loop-1', { kind: 'loop', depth: 0, startTime: 1000 }));
    nodes.set('handler-a', makeNode('handler-a', { parentId: 'loop-1', kind: 'run', depth: 1, startTime: 2000 }));
    nodes.set('handler-b', makeNode('handler-b', { parentId: 'loop-1', kind: 'llm', depth: 1, startTime: 3000 }));

    const { positions, edges } = calculateSequentialLayout(nodes, 'loop-1');

    // 3 positions: 1 container + 2 leaf nodes
    expect(positions).toHaveLength(3);

    const loopPos = positions.find((p) => p.id === 'loop-1');
    const handlerAPos = positions.find((p) => p.id === 'handler-a');
    const handlerBPos = positions.find((p) => p.id === 'handler-b');

    expect(loopPos).toBeDefined();
    expect(handlerAPos).toBeDefined();
    expect(handlerBPos).toBeDefined();

    // Loop position should be a container
    expect(loopPos!.isContainer).toBe(true);

    // Children should be inside the container bounds
    expect(handlerAPos!.x).toBeGreaterThan(loopPos!.x);
    expect(handlerAPos!.y).toBeGreaterThan(loopPos!.y);
    expect(handlerBPos!.x).toBeGreaterThan(loopPos!.x);

    // Children should be stacked vertically
    expect(handlerBPos!.y).toBeGreaterThan(handlerAPos!.y);

    // Should have edge from handler-a to handler-b
    const sequentialEdge = edges.find((e) => e.source === 'handler-a' && e.target === 'handler-b');
    expect(sequentialEdge).toBeDefined();

    // Should have loop-back edge from handler-b to handler-a
    const loopEdge = edges.find((e) => e.type === 'loop');
    expect(loopEdge).toBeDefined();
    expect(loopEdge!.source).toBe('handler-b');
    expect(loopEdge!.target).toBe('handler-a');
  });

  it('renders fork as container with children side by side', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('fork-1', makeNode('fork-1', { kind: 'fork', depth: 0, startTime: 1000 }));
    nodes.set('path-1', makeNode('path-1', { parentId: 'fork-1', kind: 'run', depth: 1, startTime: 2000 }));
    nodes.set('path-2', makeNode('path-2', { parentId: 'fork-1', kind: 'run', depth: 1, startTime: 2000 }));

    const { positions } = calculateSequentialLayout(nodes, 'fork-1');

    expect(positions).toHaveLength(3);

    const forkPos = positions.find((p) => p.id === 'fork-1');
    const path1Pos = positions.find((p) => p.id === 'path-1');
    const path2Pos = positions.find((p) => p.id === 'path-2');

    expect(forkPos!.isContainer).toBe(true);

    // Paths should be at the same y (side by side)
    expect(path1Pos!.y).toBe(path2Pos!.y);
    // But different x
    expect(path2Pos!.x).toBeGreaterThan(path1Pos!.x);
  });

  it('renders nested containers (loop inside branch)', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('branch', makeNode('branch', { kind: 'branch', depth: 0, startTime: 1000 }));
    nodes.set('loop', makeNode('loop', { parentId: 'branch', kind: 'loop', depth: 1, startTime: 2000 }));
    nodes.set('step', makeNode('step', { parentId: 'loop', kind: 'run', depth: 2, startTime: 3000 }));

    const { positions } = calculateSequentialLayout(nodes, 'branch');

    // branch (container) > loop (container) > step (leaf)
    expect(positions).toHaveLength(3);

    const branchPos = positions.find((p) => p.id === 'branch');
    const loopPos = positions.find((p) => p.id === 'loop');
    const stepPos = positions.find((p) => p.id === 'step');

    expect(branchPos!.isContainer).toBe(true);
    expect(loopPos!.isContainer).toBe(true);
    expect(stepPos!.isContainer).toBeUndefined();

    // step inside loop inside branch
    expect(stepPos!.x).toBeGreaterThan(loopPos!.x);
    expect(loopPos!.x).toBeGreaterThan(branchPos!.x);
  });

  it('recovers when rootNodeId points to non-existent node', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('orphan-1', makeNode('orphan-1', { depth: 0, startTime: 1000 }));
    nodes.set('orphan-2', makeNode('orphan-2', { depth: 0, startTime: 2000 }));

    const { positions } = calculateSequentialLayout(nodes, 'non-existent-root');

    // Should still render the orphaned nodes
    expect(positions).toHaveLength(2);
  });
});
