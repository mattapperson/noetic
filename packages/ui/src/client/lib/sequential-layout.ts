/**
 * Sequential layout algorithm for node graph visualization
 *
 * Container nodes (loop, fork, branch, spawn) are rendered as bounding
 * boxes that visually enclose their child steps. The layout is computed
 * recursively: children are laid out first, then the container is sized
 * to fit around them.
 */

import type { ExecutionNode, NodeEdge, NodePosition } from '../types';
import { snapToGrid, snapToGridCeil } from './grid';

//#region Types

interface SequentialLayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  verticalSpacing: number;
  horizontalSpacing: number;
  containerPadTop: number;
  containerPadSide: number;
  containerPadBottom: number;
  startX: number;
  startY: number;
  gridCellSize: number;
  nestingScale: number;
}

const DEFAULT_OPTIONS: SequentialLayoutOptions = {
  nodeWidth: 280,
  nodeHeight: 140,
  verticalSpacing: 120,
  horizontalSpacing: 120,
  containerPadTop: 60,
  containerPadSide: 50,
  containerPadBottom: 40,
  startX: 60,
  startY: 60,
  gridCellSize: 20,
  nestingScale: 0.5,
};

interface LayoutResult {
  width: number;
  height: number;
  bottom: number;
}

/** Shared context threaded through the recursive layout */
interface LayoutContext {
  nodes: Map<string, ExecutionNode>;
  childrenOf: Map<string, string[]>;
  opts: SequentialLayoutOptions;
  positions: NodePosition[];
  edges: NodeEdge[];
  /** The root node ID — its children skip the nesting scale since the root
   *  container is not rendered, so top-level nodes should appear at 100%. */
  rootNodeId: string;
}

/** Position input for layout functions */
interface LayoutPlacement {
  nodeId: string;
  x: number;
  y: number;
  scale: number;
}

//#endregion

//#region Public API

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
  const positions: NodePosition[] = [];
  const edges: NodeEdge[] = [];
  const ctx: LayoutContext = {
    nodes,
    childrenOf: buildChildrenMap(nodes),
    opts,
    positions,
    edges,
    rootNodeId,
  };

  const roots = findRoots(nodes, rootNodeId);

  let cursorY = opts.startY;
  for (let i = 0; i < roots.length; i++) {
    const id = roots[i];
    const result = layoutNode(
      {
        nodeId: id,
        x: opts.startX,
        y: cursorY,
        scale: 1,
      },
      ctx,
    );
    cursorY = result.bottom + opts.verticalSpacing;

    // Edge from this root to the next root
    if (i < roots.length - 1) {
      ctx.edges.push({
        id: `${id}-${roots[i + 1]}`,
        source: id,
        target: roots[i + 1],
        type: 'default',
        animated: ctx.nodes.get(id)?.status === 'running',
      });
    }
  }

  // Deduplicate positions and edges by ID to prevent React key warnings.
  // This guards against nodes being visited more than once if the trace
  // contains inconsistent parent/child references.
  const seenPositionIds = new Set<string>();
  const uniquePositions = positions.filter((p) => {
    if (seenPositionIds.has(p.id)) {
      return false;
    }
    seenPositionIds.add(p.id);
    return true;
  });

  const seenEdgeIds = new Set<string>();
  const uniqueEdges = edges.filter((e) => {
    if (seenEdgeIds.has(e.id)) {
      return false;
    }
    seenEdgeIds.add(e.id);
    return true;
  });

  return {
    positions: uniquePositions,
    edges: uniqueEdges,
  };
}

//#endregion

//#region Layout Engine

function layoutNode(placement: LayoutPlacement, ctx: LayoutContext): LayoutResult {
  const { nodeId, x, y, scale } = placement;
  const node = ctx.nodes.get(nodeId);
  if (!node) {
    return {
      width: 0,
      height: 0,
      bottom: y,
    };
  }

  const children = ctx.childrenOf.get(nodeId) ?? node.children;
  // Any node with children is a container — not limited to specific kinds.
  // A 'run' node wrapping child steps (e.g. the harness root) must recurse
  // into its children just like loop/fork/branch/spawn.
  const isContainer = children.length > 0;

  if (!isContainer) {
    const gridSize = ctx.opts.gridCellSize * scale;
    const width = snapToGrid(ctx.opts.nodeWidth * scale, gridSize);
    const height = snapToGrid(ctx.opts.nodeHeight * scale, gridSize);
    const snappedX = snapToGrid(x, gridSize);
    const snappedY = snapToGrid(y, gridSize);
    ctx.positions.push({
      id: nodeId,
      x: snappedX,
      y: snappedY,
      width,
      height,
      scale,
    });
    return {
      width,
      height,
      bottom: snappedY + height,
    };
  }

  if (node.kind === 'fork' || node.kind === 'branch') {
    return layoutForkContainer(
      {
        nodeId,
        children,
        x,
        y,
        scale,
      },
      ctx,
    );
  }

  return layoutSequentialContainer(
    {
      nodeId,
      node,
      children,
      x,
      y,
      scale,
    },
    ctx,
  );
}

/** Args for sequential container layout */
interface SequentialContainerArgs {
  nodeId: string;
  node: ExecutionNode;
  children: string[];
  x: number;
  y: number;
  scale: number;
}

/**
 * Layout a sequential container (loop, branch, spawn).
 * Children are stacked vertically inside the container.
 */
function layoutSequentialContainer(
  args: SequentialContainerArgs,
  ctx: LayoutContext,
): LayoutResult {
  const { nodeId, node, children, x, y, scale } = args;
  const { opts } = ctx;
  const isRoot = nodeId === ctx.rootNodeId;
  const childScale = isRoot ? scale : scale * opts.nestingScale;
  const gridSize = opts.gridCellSize * scale;
  const padTop = snapToGrid(opts.containerPadTop * scale, gridSize);
  const padSide = snapToGrid(opts.containerPadSide * scale, gridSize);
  const padBottom = snapToGrid(opts.containerPadBottom * scale, gridSize);
  const snappedX = snapToGrid(x, gridSize);
  const snappedY = snapToGrid(y, gridSize);
  const innerX = snappedX + padSide;
  let innerY = snappedY + padTop;
  let maxChildWidth = snapToGrid(opts.nodeWidth * childScale, gridSize);
  let lastBottom = snappedY + padTop;

  for (let i = 0; i < children.length; i++) {
    const childId = children[i];
    const result = layoutNode(
      {
        nodeId: childId,
        x: innerX,
        y: innerY,
        scale: childScale,
      },
      ctx,
    );
    maxChildWidth = Math.max(maxChildWidth, result.width);
    lastBottom = result.bottom;
    innerY = result.bottom + snapToGrid(opts.verticalSpacing * scale, gridSize);

    // Edge from this child to the next
    if (i < children.length - 1) {
      const edgeType = node.kind === 'spawn' ? ('spawn' as const) : ('default' as const);
      ctx.edges.push({
        id: `${childId}-${children[i + 1]}`,
        source: childId,
        target: children[i + 1],
        type: edgeType,
        animated: ctx.nodes.get(childId)?.status === 'running',
      });
    }
  }

  // For loops and every, add a loop-back edge from last child to first child
  if ((node.kind === 'loop' || node.kind === 'every') && children.length > 1) {
    ctx.edges.push({
      id: `${children[children.length - 1]}-${children[0]}-loop`,
      source: children[children.length - 1],
      target: children[0],
      type: 'loop',
      animated: true,
    });
  }

  const containerWidth = snapToGrid(maxChildWidth + padSide * 2, gridSize);
  const containerHeight = snapToGridCeil(lastBottom - snappedY + padBottom, gridSize);

  ctx.positions.push({
    id: nodeId,
    x: snappedX,
    y: snappedY,
    width: containerWidth,
    height: containerHeight,
    isContainer: true,
    scale,
  });

  return {
    width: containerWidth,
    height: containerHeight,
    bottom: snappedY + containerHeight,
  };
}

/** Args for fork container layout */
interface ForkContainerArgs {
  nodeId: string;
  children: string[];
  x: number;
  y: number;
  scale: number;
}

/**
 * Layout a fork container.
 * Children are placed side by side horizontally (parallel paths).
 */
function layoutForkContainer(args: ForkContainerArgs, ctx: LayoutContext): LayoutResult {
  const { nodeId, children, x, y, scale } = args;
  const { opts } = ctx;
  const isRoot = nodeId === ctx.rootNodeId;
  const childScale = isRoot ? scale : scale * opts.nestingScale;
  const gridSize = opts.gridCellSize * scale;
  const padTop = snapToGrid(opts.containerPadTop * scale, gridSize);
  const padSide = snapToGrid(opts.containerPadSide * scale, gridSize);
  const padBottom = snapToGrid(opts.containerPadBottom * scale, gridSize);
  const snappedX = snapToGrid(x, gridSize);
  const snappedY = snapToGrid(y, gridSize);
  const innerY = snappedY + padTop;
  let innerX = snappedX + padSide;
  let maxChildHeight = snapToGrid(opts.nodeHeight * childScale, gridSize);

  for (const childId of children) {
    const result = layoutNode(
      {
        nodeId: childId,
        x: innerX,
        y: innerY,
        scale: childScale,
      },
      ctx,
    );
    maxChildHeight = Math.max(maxChildHeight, result.height);
    innerX += result.width + snapToGrid(opts.horizontalSpacing * scale, gridSize);
  }

  // Add edges from container to each child path
  const parentNode = ctx.nodes.get(nodeId);
  if (parentNode?.kind === 'branch') {
    for (const childId of children) {
      ctx.edges.push({
        id: `${nodeId}-${childId}-conditional`,
        source: nodeId,
        target: childId,
        type: 'conditional',
        animated: ctx.nodes.get(childId)?.status === 'running',
      });
    }
  } else if (parentNode?.kind === 'fork') {
    for (const childId of children) {
      ctx.edges.push({
        id: `${nodeId}-${childId}-fork`,
        source: nodeId,
        target: childId,
        type: 'fork',
        animated: ctx.nodes.get(childId)?.status === 'running',
      });
    }
  }

  const scaledHSpacing = snapToGrid(opts.horizontalSpacing * scale, gridSize);
  const containerWidth = snapToGrid(innerX - snappedX - scaledHSpacing + padSide, gridSize);
  const containerHeight = snapToGridCeil(maxChildHeight + padTop + padBottom, gridSize);
  const finalWidth = Math.max(containerWidth, snapToGrid(opts.nodeWidth * scale, gridSize));

  ctx.positions.push({
    id: nodeId,
    x: snappedX,
    y: snappedY,
    width: finalWidth,
    height: containerHeight,
    isContainer: true,
    scale,
  });

  return {
    width: finalWidth,
    height: containerHeight,
    bottom: snappedY + containerHeight,
  };
}

//#endregion

//#region Helpers

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
  for (const [, children] of childrenOf) {
    children.sort((a, b) => {
      const nodeA = nodes.get(a);
      const nodeB = nodes.get(b);
      return (nodeA?.startTime ?? 0) - (nodeB?.startTime ?? 0);
    });
  }
  return childrenOf;
}

/** Find root node IDs — nodes whose parent is not in the map */
function findRoots(nodes: Map<string, ExecutionNode>, preferredRootId: string): string[] {
  if (nodes.has(preferredRootId)) {
    return [
      preferredRootId,
    ];
  }

  const roots: string[] = [];
  for (const [id, node] of nodes) {
    if (!node.parentId || !nodes.has(node.parentId)) {
      roots.push(id);
    }
  }

  roots.sort((a, b) => {
    const nodeA = nodes.get(a);
    const nodeB = nodes.get(b);
    return (nodeA?.startTime ?? 0) - (nodeB?.startTime ?? 0);
  });

  return roots.length > 0
    ? roots
    : [
        ...nodes.keys(),
      ].slice(0, 1);
}

//#endregion

//#region Bounding Box Utilities

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
  const availableWidth = viewportWidth - padding * 2;
  const availableHeight = viewportHeight - padding * 2;
  const zoomX = availableWidth / bbox.width;
  const zoomY = availableHeight / bbox.height;
  const zoom = Math.min(zoomX, zoomY, 1);
  const x = viewportWidth / 2 - bbox.centerX * zoom;
  const y = padding + (bbox.minY < 0 ? -bbox.minY * zoom : 0);

  return {
    x,
    y: Math.max(padding, y),
    zoom,
  };
}

//#endregion
