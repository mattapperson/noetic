/**
 * Sequential layout algorithm for node graph visualization
 * Shows execution flow as a linear sequence with loop containers
 */

import type { ExecutionNode, NodeEdge, NodePosition } from '../types';

interface SequentialLayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  verticalSpacing: number;
  horizontalSpacing: number;
  loopIndent: number;
  startX: number;
  startY: number;
}

const DEFAULT_OPTIONS: SequentialLayoutOptions = {
  nodeWidth: 280,
  nodeHeight: 140,
  verticalSpacing: 200,
  horizontalSpacing: 400,
  loopIndent: 60,
  startX: 50,
  startY: 50,
};

interface LayoutContext {
  positions: NodePosition[];
  edges: NodeEdge[];
  currentY: number;
  currentX: number;
  loopDepth: number;
  loopStartNodes: Map<string, string>; // Maps iteration end node -> loop start node
}

/**
 * Calculate sequential layout for execution nodes
 * Shows execution as a linear flow with loop containers and loop-back edges
 */
export function calculateSequentialLayout(
  nodes: Map<string, ExecutionNode>,
  rootNodeId: string,
  options: Partial<SequentialLayoutOptions> = {},
): {
  positions: NodePosition[];
  edges: NodeEdge[];
} {
  const opts = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  const ctx: LayoutContext = {
    positions: [],
    edges: [],
    currentY: opts.startY,
    currentX: opts.startX,
    loopDepth: 0,
    loopStartNodes: new Map(),
  };

  // Build children lookup from parentId
  const childrenOf = buildChildrenMap(nodes);

  // Build execution order by traversing the tree
  const executionOrder = buildExecutionOrder(nodes, rootNodeId);

  // Assign positions in execution order
  for (let i = 0; i < executionOrder.length; i++) {
    const nodeId = executionOrder[i];
    const node = nodes.get(nodeId);
    if (!node) {
      continue;
    }

    const nextNodeId = executionOrder[i + 1];

    // Position the node
    const position: NodePosition = {
      id: nodeId,
      x: ctx.currentX + ctx.loopDepth * opts.loopIndent,
      y: ctx.currentY,
      width: opts.nodeWidth,
      height: opts.nodeHeight,
    };
    ctx.positions.push(position);

    // Create edge to next node
    if (nextNodeId) {
      const isLoopBack = isLoopIterationEnd(node, nextNodeId, nodes);

      ctx.edges.push({
        id: `${nodeId}-${nextNodeId}`,
        source: nodeId,
        target: nextNodeId,
        type: isLoopBack ? 'loop' : 'default',
        animated: node.status === 'running' || isLoopBack,
      });
    }

    // Handle loop nodes specially
    const loopChildren = childrenOf.get(nodeId) ?? node.children;
    if (node.kind === 'loop' && loopChildren.length > 0) {
      // Enter loop scope - indent subsequent nodes
      ctx.loopDepth++;

      // Track loop start for loop-back edges
      for (const childId of loopChildren) {
        ctx.loopStartNodes.set(childId, nodeId);
      }
    }

    // Move to next position
    ctx.currentY += opts.verticalSpacing;

    // Exit loop scope if this was the last child of a loop
    if (node.parentId) {
      const parent = nodes.get(node.parentId);
      if (parent?.kind === 'loop') {
        const parentChildren = childrenOf.get(node.parentId) ?? parent.children;
        const isLastChild = parentChildren[parentChildren.length - 1] === nodeId;
        if (isLastChild) {
          ctx.loopDepth = Math.max(0, ctx.loopDepth - 1);
        }
      }
    }
  }

  return {
    positions: ctx.positions,
    edges: ctx.edges,
  };
}

/** Build children lookup from parentId, sorted by startTime */
function buildChildrenMap(nodes: Map<string, ExecutionNode>): Map<string, string[]> {
  const childrenOf = new Map<string, string[]>();
  for (const [id, node] of nodes) {
    if (node.parentId) {
      const siblings = childrenOf.get(node.parentId) ?? [];
      siblings.push(id);
      childrenOf.set(node.parentId, siblings);
    }
  }
  // Sort each children list by startTime
  for (const [, children] of childrenOf) {
    children.sort((a, b) => {
      const nodeA = nodes.get(a);
      const nodeB = nodes.get(b);
      return (nodeA?.startTime ?? 0) - (nodeB?.startTime ?? 0);
    });
  }
  return childrenOf;
}

/**
 * Build execution order by doing a depth-first traversal
 * Derives parent-child relationships from parentId since children arrays may be empty
 */
function buildExecutionOrder(nodes: Map<string, ExecutionNode>, rootNodeId: string): string[] {
  const order: string[] = [];
  const visited = new Set<string>();

  const childrenOf = buildChildrenMap(nodes);

  function traverse(nodeId: string): void {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const node = nodes.get(nodeId);
    if (!node) {
      return;
    }

    order.push(nodeId);

    // Use derived children from parentId (already sorted by startTime), fall back to node.children
    const children = childrenOf.get(nodeId) ?? node.children;

    for (const childId of children) {
      traverse(childId);
    }
  }

  // Start from root
  traverse(rootNodeId);

  // If root traversal missed nodes (e.g., rootNodeId is wrong or missing),
  // add remaining nodes sorted by startTime
  if (order.length < nodes.size) {
    const remaining = [
      ...nodes.entries(),
    ]
      .filter(([id]) => !visited.has(id))
      .sort(([, a], [, b]) => a.startTime - b.startTime);
    for (const [id] of remaining) {
      traverse(id);
    }
  }

  return order;
}

/**
 * Check if this node is the end of a loop iteration (should loop back)
 */
function isLoopIterationEnd(
  node: ExecutionNode,
  nextNodeId: string,
  nodes: Map<string, ExecutionNode>,
): boolean {
  // Check if we're jumping back to a loop start
  const nextNode = nodes.get(nextNodeId);
  if (!nextNode) {
    return false;
  }

  // If next node is a loop and it's already been visited, this is a loop back
  // Or if we're going from a loop child back to the loop parent
  if (node.parentId) {
    const parent = nodes.get(node.parentId);
    if (parent?.kind === 'loop' && nextNodeId === node.parentId) {
      return true;
    }
  }

  return false;
}

/**
 * Calculate bounding box for a set of positions
 */
export function calculateBoundingBox(positions: NodePosition[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
} {
  if (positions.length === 0) {
    return {
      minX: 0,
      minY: 0,
      maxX: 0,
      maxY: 0,
      width: 0,
      height: 0,
      centerX: 0,
      centerY: 0,
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const pos of positions) {
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + pos.width);
    maxY = Math.max(maxY, pos.y + pos.height);
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

/**
 * Fit graph to viewport
 */
export function fitToViewport(options: {
  positions: NodePosition[];
  viewportWidth: number;
  viewportHeight: number;
  padding?: number;
}): {
  x: number;
  y: number;
  zoom: number;
} {
  const { positions, viewportWidth, viewportHeight, padding = 50 } = options;

  if (positions.length === 0) {
    return {
      x: 0,
      y: 0,
      zoom: 1,
    };
  }

  const bbox = calculateBoundingBox(positions);

  // Calculate zoom to fit
  const availableWidth = viewportWidth - padding * 2;
  const availableHeight = viewportHeight - padding * 2;

  const zoomX = availableWidth / bbox.width;
  const zoomY = availableHeight / bbox.height;
  const zoom = Math.min(zoomX, zoomY, 1); // Don't zoom in more than 100%

  // Center the graph
  const x = viewportWidth / 2 - bbox.centerX * zoom;
  const y = padding + (bbox.minY < 0 ? -bbox.minY * zoom : 0);

  return {
    x,
    y: Math.max(padding, y),
    zoom,
  };
}
