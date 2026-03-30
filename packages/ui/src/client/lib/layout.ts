/**
 * Hierarchical layout algorithm for node graph visualization
 * Implements a top-down tree layout optimized for execution flow
 */

import type { ExecutionNode, NodeEdge, NodePosition } from '../types';

interface LayoutNode {
  id: string;
  node: ExecutionNode;
  x: number;
  y: number;
  width: number;
  height: number;
  children: LayoutNode[];
  parent: LayoutNode | null;
  level: number;
}

interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  levelSpacing: number;
  siblingSpacing: number;
  startX?: number;
  startY?: number;
}

const DEFAULT_OPTIONS: LayoutOptions = {
  nodeWidth: 280,
  nodeHeight: 140,
  levelSpacing: 200,
  siblingSpacing: 40,
  startX: 0,
  startY: 0,
};

/**
 * Calculate hierarchical layout for execution nodes
 * Uses a modified Reingold-Tilford tree layout algorithm
 */
export function calculateHierarchicalLayout(
  nodes: Map<string, ExecutionNode>,
  rootNodeId: string,
  options: Partial<LayoutOptions> = {},
): {
  positions: NodePosition[];
  edges: NodeEdge[];
} {
  const opts = {
    ...DEFAULT_OPTIONS,
    ...options,
  };

  // Build tree structure
  const root = buildTree(nodes, rootNodeId, opts);

  // First pass: assign initial positions
  assignInitialPositions(root, opts);

  // Second pass: resolve overlaps
  resolveOverlaps(root, opts);

  // Third pass: center parent over children
  centerParents(root);

  // Extract positions
  const positions = extractPositions(root);

  // Generate edges
  const edges = generateEdges(nodes, rootNodeId);

  return {
    positions,
    edges,
  };
}

function buildTree(
  nodes: Map<string, ExecutionNode>,
  rootNodeId: string,
  opts: LayoutOptions,
): LayoutNode {
  const visited = new Set<string>();

  function buildNode(nodeId: string, parent: LayoutNode | null, level: number): LayoutNode | null {
    if (visited.has(nodeId)) {
      return null;
    }
    visited.add(nodeId);

    const node = nodes.get(nodeId);
    if (!node) {
      return null;
    }

    const layoutNode: LayoutNode = {
      id: nodeId,
      node,
      x: 0,
      y: level * opts.levelSpacing,
      width: opts.nodeWidth,
      height: opts.nodeHeight,
      children: [],
      parent,
      level,
    };

    // Handle fork paths specially
    if (node.kind === 'fork' && node.forkPaths) {
      // Create virtual nodes for each fork path
      for (const path of node.forkPaths) {
        for (const childId of path) {
          const child = buildNode(childId, layoutNode, level + 1);
          if (child) {
            layoutNode.children.push(child);
          }
        }
      }
    } else {
      // Regular children
      for (const childId of node.children) {
        const child = buildNode(childId, layoutNode, level + 1);
        if (child) {
          layoutNode.children.push(child);
        }
      }
    }

    return layoutNode;
  }

  const root = buildNode(rootNodeId, null, 0);
  if (!root) {
    throw new Error(`Root node ${rootNodeId} not found`);
  }

  return root;
}

function assignInitialPositions(node: LayoutNode, opts: LayoutOptions): number {
  if (node.children.length === 0) {
    // Leaf node - position will be set by parent
    return node.width;
  }

  // Assign positions to children
  let totalWidth = 0;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i];
    const childWidth = assignInitialPositions(child, opts);

    if (i === 0) {
      child.x = totalWidth;
    } else {
      child.x = totalWidth + opts.siblingSpacing;
    }

    totalWidth = child.x + childWidth;
  }

  // Center this node over its children
  const firstChild = node.children[0];
  const lastChild = node.children[node.children.length - 1];
  node.x = (firstChild.x + lastChild.x + lastChild.width - node.width) / 2;

  return totalWidth;
}

function resolveOverlaps(root: LayoutNode, opts: LayoutOptions): void {
  // Group nodes by level
  const levels = new Map<number, LayoutNode[]>();

  function collectByLevel(node: LayoutNode) {
    const level = levels.get(node.level) || [];
    level.push(node);
    levels.set(node.level, level);

    for (const child of node.children) {
      collectByLevel(child);
    }
  }

  collectByLevel(root);

  // Resolve overlaps level by level
  for (const [_, levelNodes] of levels) {
    // Sort by x position
    levelNodes.sort((a, b) => a.x - b.x);

    // Push apart overlapping nodes
    for (let i = 1; i < levelNodes.length; i++) {
      const prev = levelNodes[i - 1];
      const curr = levelNodes[i];

      const minDistance = prev.width + opts.siblingSpacing;
      const actualDistance = curr.x - prev.x;

      if (actualDistance < minDistance) {
        const shift = minDistance - actualDistance;

        // Shift current node and all its subtree
        shiftSubtree(curr, shift);
      }
    }
  }
}

function shiftSubtree(node: LayoutNode, shift: number): void {
  node.x += shift;
  for (const child of node.children) {
    shiftSubtree(child, shift);
  }
}

function centerParents(node: LayoutNode): void {
  if (node.children.length > 0) {
    const firstChild = node.children[0];
    const lastChild = node.children[node.children.length - 1];
    const childrenCenter = (firstChild.x + lastChild.x + lastChild.width) / 2;
    node.x = childrenCenter - node.width / 2;

    for (const child of node.children) {
      centerParents(child);
    }
  }
}

function extractPositions(root: LayoutNode): NodePosition[] {
  const positions: NodePosition[] = [];

  function traverse(node: LayoutNode) {
    positions.push({
      id: node.id,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
    });

    for (const child of node.children) {
      traverse(child);
    }
  }

  traverse(root);
  return positions;
}

function generateEdges(nodes: Map<string, ExecutionNode>, rootNodeId: string): NodeEdge[] {
  const edges: NodeEdge[] = [];
  const visited = new Set<string>();

  function traverse(nodeId: string) {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const node = nodes.get(nodeId);
    if (!node) {
      return;
    }

    // Handle fork paths
    if (node.kind === 'fork' && node.forkPaths) {
      for (let pathIndex = 0; pathIndex < node.forkPaths.length; pathIndex++) {
        const path = node.forkPaths[pathIndex];
        for (const childId of path) {
          edges.push({
            id: `${nodeId}-${childId}`,
            source: nodeId,
            target: childId,
            type: 'fork',
            animated: node.status === 'running',
          });
          traverse(childId);
        }
      }
    } else {
      // Regular children
      for (const childId of node.children) {
        edges.push({
          id: `${nodeId}-${childId}`,
          source: nodeId,
          target: childId,
          type: node.kind === 'branch' ? 'conditional' : 'default',
          animated: node.status === 'running',
        });
        traverse(childId);
      }
    }
  }

  traverse(rootNodeId);
  return edges;
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
  const bbox = calculateBoundingBox(positions);

  const availableWidth = viewportWidth - padding * 2;
  const availableHeight = viewportHeight - padding * 2;

  const scaleX = availableWidth / bbox.width;
  const scaleY = availableHeight / bbox.height;
  const zoom = Math.min(scaleX, scaleY, 1); // Cap at 1x zoom

  // Center the graph
  const x = viewportWidth / 2 - bbox.centerX * zoom;
  const y = padding - bbox.minY * zoom;

  return {
    x,
    y,
    zoom,
  };
}
