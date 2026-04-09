/**
 * Orthogonal edge router
 *
 * Hybrid strategy:
 * 1. Simple rules for common flow (supports all 4 anchor sides)
 * 2. A* grid pathfinder for edges that would cross a node
 */

import type { NodePosition, OrthogonalEdge, Waypoint } from '../types';
import { snapToGrid } from './grid';

//#region Types

type Side = 'top' | 'right' | 'bottom' | 'left';

interface AnchorPoint {
  x: number;
  y: number;
  side: Side;
}

interface GridCell {
  x: number;
  y: number;
}

interface AstarNode {
  cell: GridCell;
  g: number;
  h: number;
  f: number;
  parent: AstarNode | null;
}

interface AstarContext {
  source: AnchorPoint;
  target: AnchorPoint;
  obstacles: NodePosition[];
  sourceNode: NodePosition;
  targetNode: NodePosition;
}

interface NeighborContext {
  current: AstarNode;
  dir: GridCell;
  endCell: GridCell;
  blocked: Set<string>;
  closedSet: Set<string>;
  openList: AstarNode[];
}

//#endregion

//#region Constants

const CELL_SIZE = 20;
const OBSTACLE_MARGIN = 20;
const MAX_ASTAR_ITERATIONS = 5000;

//#endregion

//#region Public API

/**
 * Route an edge between two nodes using orthogonal segments.
 * Anchors attach to the top/right/bottom/left center of each node.
 * Returns waypoints forming a horizontal/vertical polyline that avoids obstacles.
 */
export function routeEdge(
  source: NodePosition,
  target: NodePosition,
  obstacles: NodePosition[],
): OrthogonalEdge {
  const sourceAnchor = getAnchor(source, target);
  const targetAnchor = getAnchor(target, source);

  const simpleRoute = computeSimpleRoute(sourceAnchor, targetAnchor);

  const crosses = obstacles.some(
    (obs) => obs.id !== source.id && obs.id !== target.id && routeIntersectsRect(simpleRoute, obs),
  );

  if (!crosses) {
    return {
      waypoints: simpleRoute,
      edgeId: `${source.id}-${target.id}`,
    };
  }

  const astarRoute = computeAstarRoute({
    source: sourceAnchor,
    target: targetAnchor,
    obstacles,
    sourceNode: source,
    targetNode: target,
  });
  return {
    waypoints: astarRoute,
    edgeId: `${source.id}-${target.id}`,
  };
}

/**
 * Route multiple edges, offsetting parallel edges that share corridor segments.
 */
export function routeAllEdges(
  edges: Array<{
    source: NodePosition;
    target: NodePosition;
    id: string;
  }>,
  obstacles: NodePosition[],
): Map<string, OrthogonalEdge> {
  const result = new Map<string, OrthogonalEdge>();

  for (const edge of edges) {
    const route = routeEdge(edge.source, edge.target, obstacles);
    result.set(edge.id, {
      ...route,
      edgeId: edge.id,
    });
  }

  return result;
}

//#endregion

//#region Anchor Points

/** Check if outer fully contains inner */
function containsNode(outer: NodePosition, inner: NodePosition): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/**
 * Pick the anchor side of `node` that faces toward `toward`.
 *
 * Special case: when one node contains the other (container↔child edges),
 * use vertical anchors aligned to the inner node's center-x so the line
 * drops straight down from the container top to the child top.
 *
 * Normal case: uses edge-to-edge gaps — the side with the most clearance
 * toward the target wins, giving the route the most room.
 */
function getAnchor(node: NodePosition, toward: NodePosition): AnchorPoint {
  const towardCx = toward.x + toward.width / 2;
  const nodeCx = node.x + node.width / 2;

  // Container → child: anchor at top of container, aligned to child's center-x
  if (containsNode(node, toward)) {
    return { x: towardCx, y: node.y, side: 'top' };
  }

  // Child → container: anchor at top of child (line goes up toward container header)
  if (containsNode(toward, node)) {
    return { x: nodeCx, y: node.y, side: 'top' };
  }

  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;

  interface Candidate {
    side: Side;
    gap: number;
    x: number;
    y: number;
  }

  const candidates: Candidate[] = [
    { side: 'bottom', gap: toward.y - (node.y + node.height), x: cx, y: node.y + node.height },
    { side: 'top', gap: node.y - (toward.y + toward.height), x: cx, y: node.y },
    { side: 'right', gap: toward.x - (node.x + node.width), x: node.x + node.width, y: cy },
    { side: 'left', gap: node.x - (toward.x + toward.width), x: node.x, y: cy },
  ];

  // Only consider sides with positive gap (target is on that side with clearance)
  const valid = candidates.filter((c) => c.gap > 0);

  if (valid.length === 0) {
    // Nodes overlap — pick the side with the least negative gap
    candidates.sort((a, b) => b.gap - a.gap);
    return { x: candidates[0].x, y: candidates[0].y, side: candidates[0].side };
  }

  // Pick the side with the largest gap (most room for routing)
  valid.sort((a, b) => b.gap - a.gap);
  return { x: valid[0].x, y: valid[0].y, side: valid[0].side };
}

//#endregion

//#region Helpers

function isVerticalSide(side: Side): boolean {
  return side === 'top' || side === 'bottom';
}

/** Remove duplicate consecutive points and collinear intermediate points */
function simplifyWaypoints(points: Waypoint[]): Waypoint[] {
  if (points.length <= 2) {
    return points;
  }

  const result: Waypoint[] = [points[0]];

  for (let i = 1; i < points.length; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];

    // Skip duplicate points
    if (prev.x === curr.x && prev.y === curr.y) {
      continue;
    }

    // Check if collinear with the previous result point and the next input point
    if (i < points.length - 1) {
      const next = points[i + 1];
      const collinearX = prev.x === curr.x && curr.x === next.x;
      const collinearY = prev.y === curr.y && curr.y === next.y;
      if (collinearX || collinearY) {
        continue;
      }
    }

    result.push(curr);
  }

  return result;
}

//#endregion

//#region Simple Route

/**
 * Compute an orthogonal route between two anchors using Z-shaped or L-shaped
 * paths. The anchor sides determine the shape:
 *   both vertical  → Z (vertical–horizontal–vertical)
 *   both horizontal → Z (horizontal–vertical–horizontal)
 *   mixed          → L (one turn)
 */
function computeSimpleRoute(source: AnchorPoint, target: AnchorPoint): Waypoint[] {
  const start: Waypoint = { x: source.x, y: source.y };
  const end: Waypoint = { x: target.x, y: target.y };

  // Direct line (aligned anchors)
  if (start.x === end.x || start.y === end.y) {
    return [start, end];
  }

  const srcVert = isVerticalSide(source.side);
  const tgtVert = isVerticalSide(target.side);

  // Both vertical: Z-shape vertical → horizontal → vertical
  if (srcVert && tgtVert) {
    const midY = snapToGrid((start.y + end.y) / 2);
    return simplifyWaypoints([
      start,
      { x: start.x, y: midY },
      { x: end.x, y: midY },
      end,
    ]);
  }

  // Both horizontal: Z-shape horizontal → vertical → horizontal
  if (!srcVert && !tgtVert) {
    const midX = snapToGrid((start.x + end.x) / 2);
    return simplifyWaypoints([
      start,
      { x: midX, y: start.y },
      { x: midX, y: end.y },
      end,
    ]);
  }

  // Mixed: L-shape (one turn)
  if (srcVert) {
    // Vertical exit → horizontal entry: corner at (source.x, target.y)
    return simplifyWaypoints([start, { x: start.x, y: end.y }, end]);
  }

  // Horizontal exit → vertical entry: corner at (target.x, source.y)
  return simplifyWaypoints([start, { x: end.x, y: start.y }, end]);
}

//#endregion

//#region Intersection Check

/** Check if a polyline route intersects a rectangle (node bounding box) */
function routeIntersectsRect(route: Waypoint[], rect: NodePosition): boolean {
  const margin = 10;
  const rx1 = rect.x - margin;
  const ry1 = rect.y - margin;
  const rx2 = rect.x + rect.width + margin;
  const ry2 = rect.y + rect.height + margin;

  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    if (
      segmentIntersectsRect({
        a,
        b,
        rx1,
        ry1,
        rx2,
        ry2,
      })
    ) {
      return true;
    }
  }
  return false;
}

/** Check if an axis-aligned segment intersects a rectangle */
function segmentIntersectsRect({
  a,
  b,
  rx1,
  ry1,
  rx2,
  ry2,
}: {
  a: Waypoint;
  b: Waypoint;
  rx1: number;
  ry1: number;
  rx2: number;
  ry2: number;
}): boolean {
  // Segment is horizontal
  if (a.y === b.y) {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    return a.y > ry1 && a.y < ry2 && maxX > rx1 && minX < rx2;
  }
  // Segment is vertical
  if (a.x === b.x) {
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    return a.x > rx1 && a.x < rx2 && maxY > ry1 && minY < ry2;
  }
  return false;
}

//#endregion

//#region A* Pathfinder

/** Compute an orthogonal route using A* on the snap grid */
function computeAstarRoute({
  source,
  target,
  obstacles,
  sourceNode,
  targetNode,
}: AstarContext): Waypoint[] {
  const blocked = buildBlockedSet(obstacles, sourceNode, targetNode);

  const startCell: GridCell = {
    x: snapToGrid(source.x),
    y: snapToGrid(source.y),
  };
  const endCell: GridCell = {
    x: snapToGrid(target.x),
    y: snapToGrid(target.y),
  };

  const startNode: AstarNode = {
    cell: startCell,
    g: 0,
    h: manhattan(startCell, endCell),
    f: manhattan(startCell, endCell),
    parent: null,
  };

  const openList: AstarNode[] = [
    startNode,
  ];
  const closedSet = new Set<string>();

  const directions: GridCell[] = [
    { x: CELL_SIZE, y: 0 },
    { x: -CELL_SIZE, y: 0 },
    { x: 0, y: CELL_SIZE },
    { x: 0, y: -CELL_SIZE },
  ];

  let iterations = 0;

  while (openList.length > 0 && iterations < MAX_ASTAR_ITERATIONS) {
    iterations++;
    openList.sort((a, b) => a.f - b.f);
    const current = openList.shift()!;
    const key = cellKey(current.cell);

    if (current.cell.x === endCell.x && current.cell.y === endCell.y) {
      const path = reconstructPath(current);
      // Replace snapped first/last waypoints with exact anchor coordinates
      // so the path meets the node edges precisely.
      path[0] = { x: source.x, y: source.y };
      path[path.length - 1] = { x: target.x, y: target.y };
      return path;
    }

    closedSet.add(key);

    for (const dir of directions) {
      processNeighbor({
        current,
        dir,
        endCell,
        blocked,
        closedSet,
        openList,
      });
    }
  }

  // Fallback: simple route if A* exhausts iterations
  return computeSimpleRoute(source, target);
}

function buildBlockedSet(
  obstacles: NodePosition[],
  sourceNode: NodePosition,
  targetNode: NodePosition,
): Set<string> {
  const blocked = new Set<string>();

  for (const obs of obstacles) {
    if (obs.id === sourceNode.id || obs.id === targetNode.id) {
      continue;
    }
    const x1 = snapToGrid(obs.x - OBSTACLE_MARGIN);
    const y1 = snapToGrid(obs.y - OBSTACLE_MARGIN);
    const x2 = snapToGrid(obs.x + obs.width + OBSTACLE_MARGIN);
    const y2 = snapToGrid(obs.y + obs.height + OBSTACLE_MARGIN);
    for (let gx = x1; gx <= x2; gx += CELL_SIZE) {
      for (let gy = y1; gy <= y2; gy += CELL_SIZE) {
        blocked.add(`${gx},${gy}`);
      }
    }
  }

  return blocked;
}

function processNeighbor({
  current,
  dir,
  endCell,
  blocked,
  closedSet,
  openList,
}: NeighborContext): void {
  const nextCell: GridCell = {
    x: current.cell.x + dir.x,
    y: current.cell.y + dir.y,
  };
  const nextKey = cellKey(nextCell);

  if (closedSet.has(nextKey) || blocked.has(nextKey)) {
    return;
  }

  const turnPenalty = computeTurnPenalty(current, dir);
  const g = current.g + CELL_SIZE + turnPenalty;
  const h = manhattan(nextCell, endCell);

  const existing = openList.find((n) => n.cell.x === nextCell.x && n.cell.y === nextCell.y);
  if (existing) {
    if (g < existing.g) {
      existing.g = g;
      existing.f = g + h;
      existing.parent = current;
    }
    return;
  }

  openList.push({
    cell: nextCell,
    g,
    h,
    f: g + h,
    parent: current,
  });
}

function computeTurnPenalty(current: AstarNode, dir: GridCell): number {
  if (!current.parent) {
    return 0;
  }
  const prevDx = current.cell.x - current.parent.cell.x;
  const prevDy = current.cell.y - current.parent.cell.y;
  const isTurn = prevDx !== dir.x || prevDy !== dir.y;
  return isTurn ? CELL_SIZE * 2 : 0;
}

function cellKey(cell: GridCell): string {
  return `${cell.x},${cell.y}`;
}

function manhattan(a: GridCell, b: GridCell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Reconstruct path from A* result, simplifying collinear points */
function reconstructPath(node: AstarNode): Waypoint[] {
  const raw: Waypoint[] = [];
  let current: AstarNode | null = node;
  while (current) {
    raw.unshift({
      x: current.cell.x,
      y: current.cell.y,
    });
    current = current.parent;
  }

  if (raw.length <= 2) {
    return raw;
  }

  // Remove collinear intermediate points
  const simplified: Waypoint[] = [
    raw[0],
  ];
  for (let i = 1; i < raw.length - 1; i++) {
    const prev = raw[i - 1];
    const curr = raw[i];
    const next = raw[i + 1];
    const sameX = prev.x === curr.x && curr.x === next.x;
    const sameY = prev.y === curr.y && curr.y === next.y;
    if (!sameX && !sameY) {
      simplified.push(curr);
    }
  }
  simplified.push(raw[raw.length - 1]);

  return simplified;
}

//#endregion
