/**
 * Tests that rootNodeId is correctly computed when spans arrive depth-first.
 *
 * The exporter sends spans innermost-first, so the server receives the deepest
 * child before the actual root. This test verifies that the server recomputes
 * rootNodeId at save time so stored traces render correctly.
 */

import { describe, expect, it } from 'bun:test';
import { calculateSequentialLayout } from '../src/client/lib/sequential-layout';
import type { ExecutionNode } from '../src/shared/protocol';

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

function makeNode(
  id: string,
  opts: {
    parentId?: string | null;
    kind?: ExecutionNode['kind'];
    depth?: number;
    startTime?: number;
    children?: string[];
  } = {},
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
    contextSnapshot: {
      ...ZERO_SNAPSHOT,
      depth: opts.depth ?? 0,
    },
    stepData: {
      description: '',
    } satisfies ExecutionNode['stepData'],
    children: opts.children ?? [],
  };
}

/**
 * Simulates the server-side computeRootNodeId logic.
 * This must match NoeticUIServer.computeRootNodeId exactly.
 */
function computeRootNodeId(nodes: Map<string, ExecutionNode>): string {
  for (const [id, node] of nodes) {
    if (!node.parentId) {
      return id;
    }
  }
  for (const [id, node] of nodes) {
    if (node.parentId && !nodes.has(node.parentId)) {
      return id;
    }
  }
  return nodes.keys().next().value ?? '';
}

/**
 * Simulate the server's handleTraceNodeStart: add nodes in depth-first
 * (innermost-first) order and wire parent.children.
 */
function simulateDepthFirstArrival(depthFirstOrder: ExecutionNode[]): {
  nodes: Map<string, ExecutionNode>;
  rootNodeId: string;
} {
  const nodes = new Map<string, ExecutionNode>();
  let rootNodeId = '';

  for (const node of depthFirstOrder) {
    nodes.set(node.id, node);

    // Wire parent children (same as server handleTraceNodeStart)
    if (node.parentId) {
      const parent = nodes.get(node.parentId);
      if (parent && !parent.children.includes(node.id)) {
        parent.children.push(node.id);
      }
    }

    // Old heuristic (broken): set rootNodeId to first node whose parent isn't in map
    if (!rootNodeId) {
      const parentExists = node.parentId && nodes.has(node.parentId);
      if (!parentExists) {
        rootNodeId = node.id;
      }
    }
  }

  return {
    nodes,
    rootNodeId,
  };
}

//#endregion

describe('rootNodeId computation', () => {
  it('old heuristic picks deepest child when spans arrive depth-first', () => {
    const root = makeNode('root', {
      kind: 'loop',
      startTime: 1000,
    });
    const child = makeNode('child', {
      parentId: 'root',
      kind: 'llm',
      startTime: 2000,
    });
    const grandchild = makeNode('grandchild', {
      parentId: 'child',
      kind: 'tool',
      startTime: 3000,
    });

    // Depth-first: innermost first
    const { rootNodeId } = simulateDepthFirstArrival([
      grandchild,
      child,
      root,
    ]);

    // Old heuristic incorrectly picks grandchild (first node whose parent isn't in map)
    expect(rootNodeId).toBe('grandchild');
  });

  it('computeRootNodeId correctly finds the true root', () => {
    const root = makeNode('root', {
      kind: 'loop',
      startTime: 1000,
    });
    const child = makeNode('child', {
      parentId: 'root',
      kind: 'llm',
      startTime: 2000,
    });
    const grandchild = makeNode('grandchild', {
      parentId: 'child',
      kind: 'tool',
      startTime: 3000,
    });

    // Simulate depth-first arrival
    const { nodes } = simulateDepthFirstArrival([
      grandchild,
      child,
      root,
    ]);

    // computeRootNodeId should find the real root
    expect(computeRootNodeId(nodes)).toBe('root');
  });

  it('computeRootNodeId handles harness root parent (unexported parent)', () => {
    // Harness creates a root span that is never exported
    const topStep = makeNode('top', {
      parentId: 'harness-root',
      kind: 'loop',
      startTime: 1000,
    });
    const child = makeNode('child', {
      parentId: 'top',
      kind: 'llm',
      startTime: 2000,
    });

    const { nodes } = simulateDepthFirstArrival([
      child,
      topStep,
    ]);

    // No node has parentId === null, but topStep's parent isn't in the map
    expect(computeRootNodeId(nodes)).toBe('top');
  });

  it('stored trace with correct rootNodeId renders full tree', () => {
    // Build nodes as they would appear in a stored trace
    const nodes = new Map<string, ExecutionNode>();
    nodes.set(
      'root',
      makeNode('root', {
        kind: 'loop',
        startTime: 1000,
        children: [
          'child-1',
          'child-2',
        ],
      }),
    );
    nodes.set(
      'child-1',
      makeNode('child-1', {
        parentId: 'root',
        kind: 'llm',
        depth: 1,
        startTime: 2000,
      }),
    );
    nodes.set(
      'child-2',
      makeNode('child-2', {
        parentId: 'root',
        kind: 'tool',
        depth: 1,
        startTime: 3000,
      }),
    );

    // With correct rootNodeId, layout produces positions for all nodes
    const correctRoot = computeRootNodeId(nodes);
    const { positions } = calculateSequentialLayout(nodes, correctRoot);
    expect(positions.length).toBe(3);
  });

  it('wrong rootNodeId still renders only the targeted leaf', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set(
      'root',
      makeNode('root', {
        kind: 'loop',
        startTime: 1000,
        children: [
          'child-1',
          'child-2',
        ],
      }),
    );
    nodes.set(
      'child-1',
      makeNode('child-1', {
        parentId: 'root',
        kind: 'llm',
        depth: 1,
        startTime: 2000,
      }),
    );
    nodes.set(
      'child-2',
      makeNode('child-2', {
        parentId: 'root',
        kind: 'tool',
        depth: 1,
        startTime: 3000,
      }),
    );

    // Wrong rootNodeId: points to a leaf node (no children of its own)
    const { positions } = calculateSequentialLayout(nodes, 'child-1');
    expect(positions.length).toBe(1);
  });

  it('run-kind root with children renders as container (harness root)', () => {
    // The harness exports a 'run' root that wraps step children.
    // The layout must recurse into children for ANY kind, not just
    // loop/fork/branch/spawn.
    const nodes = new Map<string, ExecutionNode>();
    nodes.set(
      'harness-root',
      makeNode('harness-root', {
        kind: 'run',
        startTime: 1000,
      }),
    );
    nodes.set(
      'llm-step',
      makeNode('llm-step', {
        parentId: 'harness-root',
        kind: 'llm',
        depth: 1,
        startTime: 2000,
      }),
    );

    const { positions } = calculateSequentialLayout(nodes, 'harness-root');
    // Both nodes must be laid out: container + child
    expect(positions.length).toBe(2);
    expect(positions.filter((p) => p.isContainer)).toHaveLength(1);
  });

  it('run-kind root wrapping a loop renders full tree', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set(
      'harness-root',
      makeNode('harness-root', {
        kind: 'run',
        startTime: 1000,
      }),
    );
    nodes.set(
      'loop',
      makeNode('loop', {
        parentId: 'harness-root',
        kind: 'loop',
        depth: 1,
        startTime: 2000,
      }),
    );
    nodes.set(
      'iter-1',
      makeNode('iter-1', {
        parentId: 'loop',
        kind: 'llm',
        depth: 2,
        startTime: 3000,
      }),
    );
    nodes.set(
      'iter-2',
      makeNode('iter-2', {
        parentId: 'loop',
        kind: 'llm',
        depth: 2,
        startTime: 4000,
      }),
    );

    const { positions } = calculateSequentialLayout(nodes, 'harness-root');
    // harness-root (container) > loop (container) > iter-1, iter-2
    expect(positions.length).toBe(4);
    expect(positions.filter((p) => p.isContainer)).toHaveLength(2);
  });

  it('depth-first arrival + recompute produces correct layout', () => {
    // Full round-trip simulation:
    // 1. Nodes arrive depth-first (exporter order)
    // 2. Server stores trace
    // 3. Recompute rootNodeId at save time
    // 4. Layout produces full tree

    const root = makeNode('root', {
      kind: 'loop',
      startTime: 1000,
    });
    const child1 = makeNode('child-1', {
      parentId: 'root',
      kind: 'llm',
      startTime: 2000,
    });
    const child2 = makeNode('child-2', {
      parentId: 'root',
      kind: 'tool',
      startTime: 3000,
    });

    // Step 1: Depth-first arrival (innermost first)
    const { nodes, rootNodeId: wrongRoot } = simulateDepthFirstArrival([
      child2,
      child1,
      root,
    ]);

    // The old heuristic picks wrong root
    expect(wrongRoot).not.toBe('root');

    // Step 3: Recompute
    const correctRoot = computeRootNodeId(nodes);
    expect(correctRoot).toBe('root');

    // Step 4: Layout with correct root shows all nodes
    const { positions } = calculateSequentialLayout(nodes, correctRoot);
    expect(positions.length).toBe(3);
    // Container (loop root) + 2 children
    expect(positions.filter((p) => p.isContainer)).toHaveLength(1);
  });
});
