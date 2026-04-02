/**
 * Sequential layout algorithm for node graph visualization
 *
 * Container nodes (loop, fork, branch, spawn) are rendered as bounding
 * boxes that visually enclose their child steps. The layout is computed
 * recursively: children are laid out first, then the container is sized
 * to fit around them.
 */

import type { ExecutionNode, NodeEdge, NodePosition } from '../types';
import { snapToGrid } from './grid';

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
  verticalSpacing: 60,
  horizontalSpacing: 80,
  containerPadTop: 50,
  containerPadSide: 30,
  containerPadBottom: 30,
  startX: 60,
  startY: 60,
  gridCellSize: 20,
  nestingScale: 0.5,
};

const CONTAINER_KINDS = new Set([
  'loop',
  'fork',
  'branch',
  'spawn',
]);

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
  };

  const roots = findRoots(nodes, rootNodeId);

  let cursorY = opts.startY;
  for (const id of roots) {
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
  }

  return {
    positions,
    edges,
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
  const isContainer = CONTAINER_KINDS.has(node.kind) && children.length > 0;

  if (!isContainer) {
    const width = snapToGrid(ctx.opts.nodeWidth * scale);
    const height = snapToGrid(ctx.opts.nodeHeight * scale);
    const snappedX = snapToGrid(x);
    const snappedY = snapToGrid(y);
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
  const childScale = scale * opts.nestingScale;
  const padTop = snapToGrid(opts.containerPadTop * scale);
  const padSide = snapToGrid(opts.containerPadSide * scale);
  const padBottom = snapToGrid(opts.containerPadBottom * scale);
  const snappedX = snapToGrid(x);
  const snappedY = snapToGrid(y);
  const innerX = snappedX + padSide;
  let innerY = snappedY + padTop;
  let maxChildWidth = snapToGrid(opts.nodeWidth * childScale);
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
    innerY = result.bottom + opts.verticalSpacing;

    // Edge from this child to the next
    if (i < children.length - 1) {
      ctx.edges.push({
        id: `${childId}-${children[i + 1]}`,
        source: childId,
        target: children[i + 1],
        type: 'default',
        animated: ctx.nodes.get(childId)?.status === 'running',
      });
    }
  }

  // For loops, add a loop-back edge from last child to first child
  if (node.kind === 'loop' && children.length > 1) {
    ctx.edges.push({
      id: `${children[children.length - 1]}-${children[0]}-loop`,
      source: children[children.length - 1],
      target: children[0],
      type: 'loop',
      animated: true,
    });
  }

  const containerWidth = snapToGrid(maxChildWidth + padSide * 2);
  const containerHeight = snapToGrid(lastBottom - snappedY + padBottom);

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
  const childScale = scale * opts.nestingScale;
  const padTop = snapToGrid(opts.containerPadTop * scale);
  const padSide = snapToGrid(opts.containerPadSide * scale);
  const padBottom = snapToGrid(opts.containerPadBottom * scale);
  const snappedX = snapToGrid(x);
  const snappedY = snapToGrid(y);
  const innerY = snappedY + padTop;
  let innerX = snappedX + padSide;
  let maxChildHeight = snapToGrid(opts.nodeHeight * childScale);

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
    innerX += result.width + opts.horizontalSpacing;
  }

  const containerWidth = snapToGrid(innerX - snappedX - opts.horizontalSpacing + padSide);
  const containerHeight = snapToGrid(maxChildHeight + padTop + padBottom);
  const finalWidth = Math.max(containerWidth, snapToGrid(opts.nodeWidth * scale));

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
