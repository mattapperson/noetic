/**
 * Integration test: verifies that traces with parentId-only nodes
 * (no children arrays) render correctly through the layout pipeline.
 *
 * This is the exact scenario that occurs when the exporter creates nodes
 * with children: [] and the server stores them as-is.
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
    children: [], // Intentionally empty — this is what the exporter produces
  };
}

describe('node rendering integration', () => {
  it('renders all nodes even when children arrays are empty (parentId-only)', () => {
    // Simulate what the exporter produces: nodes with parentId set but children: []
    const nodes = new Map<string, ExecutionNode>();
    const root = makeNode('root', { kind: 'run', depth: 0, startTime: 1000 });
    const step1 = makeNode('step-1', { parentId: 'root', kind: 'llm', depth: 1, startTime: 2000 });
    const step2 = makeNode('step-2', { parentId: 'root', kind: 'tool', depth: 1, startTime: 3000 });
    const step3 = makeNode('step-3', { parentId: 'root', kind: 'run', depth: 1, startTime: 4000 });

    nodes.set('root', root);
    nodes.set('step-1', step1);
    nodes.set('step-2', step2);
    nodes.set('step-3', step3);

    const { positions, edges } = calculateSequentialLayout(nodes, 'root');

    // All 4 nodes should have positions
    expect(positions).toHaveLength(4);
    expect(positions.map((p) => p.id)).toEqual(['root', 'step-1', 'step-2', 'step-3']);

    // Edges connect them sequentially
    expect(edges).toHaveLength(3);
    expect(edges[0].source).toBe('root');
    expect(edges[0].target).toBe('step-1');
    expect(edges[1].source).toBe('step-1');
    expect(edges[1].target).toBe('step-2');
    expect(edges[2].source).toBe('step-2');
    expect(edges[2].target).toBe('step-3');
  });

  it('renders nested steps with multiple levels of depth', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('root', makeNode('root', { depth: 0, startTime: 1000 }));
    nodes.set('branch', makeNode('branch', { parentId: 'root', kind: 'branch', depth: 1, startTime: 2000 }));
    nodes.set('llm-1', makeNode('llm-1', { parentId: 'branch', kind: 'llm', depth: 2, startTime: 3000 }));
    nodes.set('tool-1', makeNode('tool-1', { parentId: 'branch', kind: 'tool', depth: 2, startTime: 4000 }));
    nodes.set('final', makeNode('final', { parentId: 'root', kind: 'run', depth: 1, startTime: 5000 }));

    const { positions } = calculateSequentialLayout(nodes, 'root');

    // All 5 nodes should render
    expect(positions).toHaveLength(5);
    const ids = positions.map((p) => p.id);
    expect(ids).toContain('root');
    expect(ids).toContain('branch');
    expect(ids).toContain('llm-1');
    expect(ids).toContain('tool-1');
    expect(ids).toContain('final');
  });

  it('sorts children by startTime for correct execution order', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('root', makeNode('root', { depth: 0, startTime: 1000 }));
    // Add children in wrong order
    nodes.set('c', makeNode('c', { parentId: 'root', depth: 1, startTime: 4000 }));
    nodes.set('a', makeNode('a', { parentId: 'root', depth: 1, startTime: 2000 }));
    nodes.set('b', makeNode('b', { parentId: 'root', depth: 1, startTime: 3000 }));

    const { positions } = calculateSequentialLayout(nodes, 'root');

    expect(positions).toHaveLength(4);
    // Should be sorted: root, a, b, c (by startTime)
    expect(positions[0].id).toBe('root');
    expect(positions[1].id).toBe('a');
    expect(positions[2].id).toBe('b');
    expect(positions[3].id).toBe('c');
  });

  it('handles loop nodes with parentId-derived children', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('root', makeNode('root', { depth: 0, startTime: 1000 }));
    nodes.set('loop-1', makeNode('loop-1', { parentId: 'root', kind: 'loop', depth: 1, startTime: 2000 }));
    nodes.set('iter-1', makeNode('iter-1', { parentId: 'loop-1', kind: 'run', depth: 2, startTime: 3000 }));
    nodes.set('iter-2', makeNode('iter-2', { parentId: 'loop-1', kind: 'run', depth: 2, startTime: 4000 }));

    const { positions } = calculateSequentialLayout(nodes, 'root');

    // All 4 nodes should render
    expect(positions).toHaveLength(4);
    // Loop children should be indented
    const loopPos = positions.find((p) => p.id === 'loop-1');
    const iter1Pos = positions.find((p) => p.id === 'iter-1');
    expect(loopPos).toBeDefined();
    expect(iter1Pos).toBeDefined();
    // Iteration nodes should be indented relative to loop
    expect(iter1Pos!.x).toBeGreaterThan(loopPos!.x);
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
