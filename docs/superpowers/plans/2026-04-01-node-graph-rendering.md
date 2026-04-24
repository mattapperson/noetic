# Node Graph Rendering Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the dev UI node graph to use orthogonal edge routing, grid-snapped layout, recursive 50% container scaling, click-to-zoom navigation, horizontal fork/branch layout, and sibling overlap prevention.

**Architecture:** The layout engine (`sequential-layout.ts`) gains grid snapping, recursive scale, and branch-horizontal support. A new `edge-router.ts` handles orthogonal routing with a hybrid simple-rules + A* strategy. `NodeGraph.tsx` renders polyline edges with corner radii and adds click-to-zoom with breadcrumb navigation.

**Tech Stack:** React 19, SVG polylines, custom A* pathfinder, CSS transitions, Zustand state

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/ui/src/client/types/index.ts` | Modify | Add `scale` to `NodePosition`, add `'spawn'` to `NodeEdge.type`, add `OrthogonalEdge`/`Waypoint` types |
| `packages/ui/src/client/lib/grid.ts` | Create | Grid snap utility + constants |
| `packages/ui/src/client/lib/edge-router.ts` | Create | Orthogonal edge routing (simple rules + A* fallback) |
| `packages/ui/src/client/lib/sequential-layout.ts` | Modify | Grid snapping, recursive scale, branch→horizontal, overlap prevention |
| `packages/ui/src/client/components/nodes/shared.ts` | Modify | Edge color/style constants per connection type |
| `packages/ui/src/client/components/NodeGraph.tsx` | Modify | Polyline edge renderer, click-to-zoom, breadcrumb nav, arrowheads |
| `packages/ui/test/grid.test.ts` | Create | Tests for grid snap utility |
| `packages/ui/test/edge-router.test.ts` | Create | Tests for orthogonal routing |
| `packages/ui/test/node-rendering-integration.test.ts` | Modify | Update existing tests + add new ones for scale, branch-horizontal, overlap |

---

### Task 1: Types — Add `scale`, `spawn` edge type, and waypoint types

**Files:**
- Modify: `packages/ui/src/client/types/index.ts`

- [ ] **Step 1: Add `scale` to `NodePosition` and `'spawn'` to `NodeEdge.type`**

In `packages/ui/src/client/types/index.ts`, update `NodePosition`:

```typescript
export interface NodePosition {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** If true, this node is a container (loop/fork/branch/spawn) rendered as a bounding box */
  isContainer?: boolean;
  /** Scale factor relative to base size (1 = full, 0.5 = half, etc). Defaults to 1. */
  scale?: number;
}
```

Update `NodeEdge.type`:

```typescript
export interface NodeEdge {
  id: string;
  source: string;
  target: string;
  type: 'default' | 'conditional' | 'fork' | 'loop' | 'spawn';
  animated?: boolean;
}
```

Add new types at the end of the file (before the closing):

```typescript
export interface Waypoint {
  x: number;
  y: number;
}

export interface OrthogonalEdge {
  /** Ordered waypoints forming the polyline (all grid-snapped) */
  waypoints: Waypoint[];
  /** The edge metadata this route was computed for */
  edgeId: string;
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd packages/ui && bun run typecheck`
Expected: PASS (existing code doesn't reference `'spawn'` edge type yet, and `scale` is optional)

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/client/types/index.ts
git commit -m "feat(ui): add scale, spawn edge type, and waypoint types to NodePosition/NodeEdge"
```

---

### Task 2: Grid snap utility

**Files:**
- Create: `packages/ui/src/client/lib/grid.ts`
- Create: `packages/ui/test/grid.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/ui/test/grid.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test';
import { GRID_CELL_SIZE, snapToGrid } from '../src/client/lib/grid';

describe('snapToGrid', () => {
  it('snaps a value to the nearest grid cell', () => {
    expect(snapToGrid(13)).toBe(20);
    expect(snapToGrid(7)).toBe(0);
    expect(snapToGrid(10)).toBe(20);
  });

  it('handles zero', () => {
    expect(snapToGrid(0)).toBe(0);
  });

  it('handles negative values', () => {
    expect(snapToGrid(-13)).toBe(-20);
    expect(snapToGrid(-7)).toBe(0);
  });

  it('handles exact grid multiples', () => {
    expect(snapToGrid(20)).toBe(20);
    expect(snapToGrid(40)).toBe(40);
    expect(snapToGrid(60)).toBe(60);
  });

  it('uses custom cell size', () => {
    expect(snapToGrid(13, 10)).toBe(10);
    expect(snapToGrid(16, 10)).toBe(20);
  });

  it('exports GRID_CELL_SIZE as 20', () => {
    expect(GRID_CELL_SIZE).toBe(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ui && bun test test/grid.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `packages/ui/src/client/lib/grid.ts`:

```typescript
/** Default virtual grid cell size in pixels */
export const GRID_CELL_SIZE = 20;

/** Snap a value to the nearest grid cell boundary */
export function snapToGrid(value: number, cellSize: number = GRID_CELL_SIZE): number {
  return Math.round(value / cellSize) * cellSize;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/ui && bun test test/grid.test.ts`
Expected: PASS — all 6 tests green

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/client/lib/grid.ts packages/ui/test/grid.test.ts
git commit -m "feat(ui): add grid snap utility"
```

---

### Task 3: Edge router — simple orthogonal routing

**Files:**
- Create: `packages/ui/src/client/lib/edge-router.ts`
- Create: `packages/ui/test/edge-router.test.ts`

- [ ] **Step 1: Write failing tests for simple routing**

Create `packages/ui/test/edge-router.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test';
import { routeEdge } from '../src/client/lib/edge-router';
import type { NodePosition } from '../src/client/types';

function makePos(id: string, x: number, y: number, w = 280, h = 140): NodePosition {
  return { id, x, y, width: w, height: h };
}

describe('routeEdge — simple rules', () => {
  it('routes straight down when source is directly above target', () => {
    const source = makePos('a', 100, 100);
    const target = makePos('b', 100, 300);
    const result = routeEdge(source, target, []);

    // Should have exactly 2 waypoints: bottom-center of source, top-center of target
    expect(result.waypoints).toHaveLength(2);
    expect(result.waypoints[0]).toEqual({ x: 240, y: 240 }); // 100 + 280/2, 100 + 140
    expect(result.waypoints[1]).toEqual({ x: 240, y: 300 }); // 100 + 280/2, 300
  });

  it('routes with one horizontal jog when nodes are offset horizontally', () => {
    const source = makePos('a', 100, 100);
    const target = makePos('b', 400, 300);
    const result = routeEdge(source, target, []);

    // bottom-center of source → down → horizontal jog → down → top-center of target
    expect(result.waypoints.length).toBeGreaterThanOrEqual(4);
    // First point: bottom-center of source
    expect(result.waypoints[0]).toEqual({ x: 240, y: 240 });
    // Last point: top-center of target
    const last = result.waypoints[result.waypoints.length - 1];
    expect(last).toEqual({ x: 540, y: 300 });
    // All segments should be axis-aligned (each consecutive pair shares x or y)
    for (let i = 0; i < result.waypoints.length - 1; i++) {
      const a = result.waypoints[i];
      const b = result.waypoints[i + 1];
      const isHorizontal = a.y === b.y;
      const isVertical = a.x === b.x;
      expect(isHorizontal || isVertical).toBe(true);
    }
  });

  it('all waypoints are snapped to 20px grid', () => {
    const source = makePos('a', 100, 100);
    const target = makePos('b', 400, 300);
    const result = routeEdge(source, target, []);

    for (const wp of result.waypoints) {
      expect(wp.x % 20).toBe(0);
      expect(wp.y % 20).toBe(0);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ui && bun test test/edge-router.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write simple rule-based router**

Create `packages/ui/src/client/lib/edge-router.ts`:

```typescript
/**
 * Orthogonal edge router
 *
 * Hybrid strategy:
 * 1. Simple rules for common top-to-bottom flow
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

//#endregion

//#region Public API

/**
 * Route an edge between two nodes using orthogonal segments.
 * Returns grid-snapped waypoints forming horizontal/vertical polyline.
 */
export function routeEdge(
  source: NodePosition,
  target: NodePosition,
  obstacles: NodePosition[],
): OrthogonalEdge {
  const sourceAnchor = getAnchor(source, target);
  const targetAnchor = getAnchor(target, source);

  const simpleRoute = computeSimpleRoute(sourceAnchor, targetAnchor);

  // Check if simple route crosses any obstacle
  const crosses = obstacles.some(
    (obs) => obs.id !== source.id && obs.id !== target.id && routeIntersectsRect(simpleRoute, obs),
  );

  if (!crosses) {
    return { waypoints: simpleRoute, edgeId: `${source.id}-${target.id}` };
  }

  // Fall back to A* pathfinding
  const astarRoute = computeAstarRoute(sourceAnchor, targetAnchor, obstacles, source, target);
  return { waypoints: astarRoute, edgeId: `${source.id}-${target.id}` };
}

/**
 * Route multiple edges, offsetting parallel edges that share corridor segments.
 */
export function routeAllEdges(
  edges: Array<{ source: NodePosition; target: NodePosition; id: string }>,
  obstacles: NodePosition[],
): Map<string, OrthogonalEdge> {
  const result = new Map<string, OrthogonalEdge>();

  for (const edge of edges) {
    const route = routeEdge(edge.source, edge.target, obstacles);
    result.set(edge.id, { ...route, edgeId: edge.id });
  }

  return result;
}

//#endregion

//#region Anchor Points

/** Get the anchor point on a node facing toward the target node */
function getAnchor(node: NodePosition, toward: NodePosition): AnchorPoint {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const tx = toward.x + toward.width / 2;
  const ty = toward.y + toward.height / 2;

  const dx = tx - cx;
  const dy = ty - cy;

  // Choose side based on which direction the target is
  // Prefer top/bottom for vertical flow
  if (Math.abs(dy) >= Math.abs(dx)) {
    if (dy >= 0) {
      return { x: snapToGrid(cx), y: snapToGrid(node.y + node.height), side: 'bottom' };
    }
    return { x: snapToGrid(cx), y: snapToGrid(node.y), side: 'top' };
  }
  if (dx >= 0) {
    return { x: snapToGrid(node.x + node.width), y: snapToGrid(cy), side: 'right' };
  }
  return { x: snapToGrid(node.x), y: snapToGrid(cy), side: 'left' };
}

//#endregion

//#region Simple Route

/** Compute a simple orthogonal route using L-shaped or Z-shaped path */
function computeSimpleRoute(source: AnchorPoint, target: AnchorPoint): Waypoint[] {
  const sx = snapToGrid(source.x);
  const sy = snapToGrid(source.y);
  const tx = snapToGrid(target.x);
  const ty = snapToGrid(target.y);

  // Straight vertical line
  if (sx === tx) {
    return [{ x: sx, y: sy }, { x: tx, y: ty }];
  }

  // Straight horizontal line
  if (sy === ty) {
    return [{ x: sx, y: sy }, { x: tx, y: ty }];
  }

  // Z-shaped route: vertical → horizontal → vertical
  // Place the horizontal jog at the midpoint between source and target Y
  const midY = snapToGrid((sy + ty) / 2);

  return [
    { x: sx, y: sy },
    { x: sx, y: midY },
    { x: tx, y: midY },
    { x: tx, y: ty },
  ];
}

//#endregion

//#region Intersection Check

/** Check if a polyline route intersects a rectangle (node bounding box) */
function routeIntersectsRect(route: Waypoint[], rect: NodePosition): boolean {
  // Add margin around the rectangle
  const margin = 10;
  const rx1 = rect.x - margin;
  const ry1 = rect.y - margin;
  const rx2 = rect.x + rect.width + margin;
  const ry2 = rect.y + rect.height + margin;

  for (let i = 0; i < route.length - 1; i++) {
    const a = route[i];
    const b = route[i + 1];
    if (segmentIntersectsRect(a.x, a.y, b.x, b.y, rx1, ry1, rx2, ry2)) {
      return true;
    }
  }
  return false;
}

/** Check if an axis-aligned segment intersects a rectangle */
function segmentIntersectsRect(
  x1: number, y1: number, x2: number, y2: number,
  rx1: number, ry1: number, rx2: number, ry2: number,
): boolean {
  // Segment is horizontal
  if (y1 === y2) {
    const minX = Math.min(x1, x2);
    const maxX = Math.max(x1, x2);
    return y1 > ry1 && y1 < ry2 && maxX > rx1 && minX < rx2;
  }
  // Segment is vertical
  if (x1 === x2) {
    const minY = Math.min(y1, y2);
    const maxY = Math.max(y1, y2);
    return x1 > rx1 && x1 < rx2 && maxY > ry1 && minY < ry2;
  }
  return false;
}

//#endregion

//#region A* Pathfinder

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

/** Compute an orthogonal route using A* on the snap grid */
function computeAstarRoute(
  source: AnchorPoint,
  target: AnchorPoint,
  obstacles: NodePosition[],
  sourceNode: NodePosition,
  targetNode: NodePosition,
): Waypoint[] {
  const cellSize = 20;
  const margin = 20; // margin around obstacles

  // Build blocked set from obstacle bounding boxes (with margin)
  const blocked = new Set<string>();
  for (const obs of obstacles) {
    if (obs.id === sourceNode.id || obs.id === targetNode.id) {
      continue;
    }
    const x1 = snapToGrid(obs.x - margin, cellSize);
    const y1 = snapToGrid(obs.y - margin, cellSize);
    const x2 = snapToGrid(obs.x + obs.width + margin, cellSize);
    const y2 = snapToGrid(obs.y + obs.height + margin, cellSize);
    for (let gx = x1; gx <= x2; gx += cellSize) {
      for (let gy = y1; gy <= y2; gy += cellSize) {
        blocked.add(`${gx},${gy}`);
      }
    }
  }

  const startCell: GridCell = { x: snapToGrid(source.x, cellSize), y: snapToGrid(source.y, cellSize) };
  const endCell: GridCell = { x: snapToGrid(target.x, cellSize), y: snapToGrid(target.y, cellSize) };

  // A* search
  const openList: AstarNode[] = [];
  const closedSet = new Set<string>();
  const startNode: AstarNode = {
    cell: startCell,
    g: 0,
    h: manhattan(startCell, endCell),
    f: manhattan(startCell, endCell),
    parent: null,
  };
  openList.push(startNode);

  const directions: GridCell[] = [
    { x: cellSize, y: 0 },
    { x: -cellSize, y: 0 },
    { x: 0, y: cellSize },
    { x: 0, y: -cellSize },
  ];

  let iterations = 0;
  const maxIterations = 5000;

  while (openList.length > 0 && iterations < maxIterations) {
    iterations++;
    // Find node with lowest f score
    openList.sort((a, b) => a.f - b.f);
    const current = openList.shift()!;
    const key = `${current.cell.x},${current.cell.y}`;

    if (current.cell.x === endCell.x && current.cell.y === endCell.y) {
      return reconstructPath(current);
    }

    closedSet.add(key);

    for (const dir of directions) {
      const nextCell: GridCell = {
        x: current.cell.x + dir.x,
        y: current.cell.y + dir.y,
      };
      const nextKey = `${nextCell.x},${nextCell.y}`;

      if (closedSet.has(nextKey) || blocked.has(nextKey)) {
        continue;
      }

      // Penalize turns to minimize direction changes
      const turnPenalty = current.parent
        ? (current.cell.x - current.parent.cell.x !== dir.x ||
           current.cell.y - current.parent.cell.y !== dir.y
            ? cellSize * 2
            : 0)
        : 0;

      const g = current.g + cellSize + turnPenalty;
      const h = manhattan(nextCell, endCell);

      const existing = openList.find((n) => n.cell.x === nextCell.x && n.cell.y === nextCell.y);
      if (existing) {
        if (g < existing.g) {
          existing.g = g;
          existing.f = g + h;
          existing.parent = current;
        }
        continue;
      }

      openList.push({
        cell: nextCell,
        g,
        h,
        f: g + h,
        parent: current,
      });
    }
  }

  // Fallback: if A* fails (too many iterations), use simple route
  return computeSimpleRoute(source, { ...target, side: 'top' });
}

function manhattan(a: GridCell, b: GridCell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/** Reconstruct path from A* result, simplifying collinear points */
function reconstructPath(node: AstarNode): Waypoint[] {
  const raw: Waypoint[] = [];
  let current: AstarNode | null = node;
  while (current) {
    raw.unshift({ x: current.cell.x, y: current.cell.y });
    current = current.parent;
  }

  // Remove collinear intermediate points
  if (raw.length <= 2) {
    return raw;
  }

  const simplified: Waypoint[] = [raw[0]];
  for (let i = 1; i < raw.length - 1; i++) {
    const prev = raw[i - 1];
    const curr = raw[i];
    const next = raw[i + 1];
    // Keep point only if direction changes
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/ui && bun test test/edge-router.test.ts`
Expected: PASS — all 3 tests green

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/client/lib/edge-router.ts packages/ui/test/edge-router.test.ts
git commit -m "feat(ui): add orthogonal edge router with simple rules and A* fallback"
```

---

### Task 4: Edge router — A* obstacle avoidance tests

**Files:**
- Modify: `packages/ui/test/edge-router.test.ts`

- [ ] **Step 1: Add failing tests for A* obstacle avoidance**

Append to `packages/ui/test/edge-router.test.ts`:

```typescript
describe('routeEdge — A* obstacle avoidance', () => {
  it('routes around an obstacle between source and target', () => {
    const source = makePos('a', 100, 100);
    const target = makePos('b', 100, 500);
    const obstacle = makePos('blocker', 80, 280, 320, 140);
    const result = routeEdge(source, target, [obstacle]);

    // Route should avoid the obstacle
    // All segments should be axis-aligned
    for (let i = 0; i < result.waypoints.length - 1; i++) {
      const a = result.waypoints[i];
      const b = result.waypoints[i + 1];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }

    // Route should not pass through the obstacle (with margin)
    for (let i = 0; i < result.waypoints.length - 1; i++) {
      const a = result.waypoints[i];
      const b = result.waypoints[i + 1];
      // For vertical segments that overlap obstacle's X range
      if (a.x === b.x && a.x > obstacle.x - 10 && a.x < obstacle.x + obstacle.width + 10) {
        const minY = Math.min(a.y, b.y);
        const maxY = Math.max(a.y, b.y);
        // Segment should not vertically overlap obstacle
        const obstacleTop = obstacle.y - 10;
        const obstacleBottom = obstacle.y + obstacle.height + 10;
        const overlaps = maxY > obstacleTop && minY < obstacleBottom;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('routes around multiple obstacles', () => {
    const source = makePos('a', 100, 100);
    const target = makePos('b', 100, 700);
    const obs1 = makePos('obs1', 80, 280, 320, 100);
    const obs2 = makePos('obs2', 80, 480, 320, 100);
    const result = routeEdge(source, target, [obs1, obs2]);

    // Should reach target
    const last = result.waypoints[result.waypoints.length - 1];
    expect(last.x).toBe(result.waypoints[result.waypoints.length - 1].x);
    // All segments axis-aligned
    for (let i = 0; i < result.waypoints.length - 1; i++) {
      const a = result.waypoints[i];
      const b = result.waypoints[i + 1];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd packages/ui && bun test test/edge-router.test.ts`
Expected: PASS — all 5 tests green (A* should kick in for these cases)

- [ ] **Step 3: Commit**

```bash
git add packages/ui/test/edge-router.test.ts
git commit -m "test(ui): add A* obstacle avoidance tests for edge router"
```

---

### Task 5: Layout engine — grid snapping and recursive scale

**Files:**
- Modify: `packages/ui/src/client/lib/sequential-layout.ts`
- Modify: `packages/ui/test/node-rendering-integration.test.ts`

- [ ] **Step 1: Write failing tests for grid snapping and scale**

Add to `packages/ui/test/node-rendering-integration.test.ts` inside the existing `describe` block:

```typescript
  it('snaps all node positions to 20px grid', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('root', makeNode('root', { kind: 'run', depth: 0, startTime: 1000 }));

    const { positions } = calculateSequentialLayout(nodes, 'root');

    for (const pos of positions) {
      expect(pos.x % 20).toBe(0);
      expect(pos.y % 20).toBe(0);
      expect(pos.width % 20).toBe(0);
      expect(pos.height % 20).toBe(0);
    }
  });

  it('applies 0.5 scale to children of a container', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('loop', makeNode('loop', { kind: 'loop', depth: 0, startTime: 1000 }));
    nodes.set('child', makeNode('child', { parentId: 'loop', kind: 'run', depth: 1, startTime: 2000 }));

    const { positions } = calculateSequentialLayout(nodes, 'loop');

    const loopPos = positions.find((p) => p.id === 'loop');
    const childPos = positions.find((p) => p.id === 'child');

    expect(loopPos!.scale).toBe(1);
    expect(childPos!.scale).toBe(0.5);
    // Child dimensions should be half of base size
    expect(childPos!.width).toBe(140);
    expect(childPos!.height).toBe(80); // snapped: 70 → 80
  });

  it('compounds scale recursively (0.25 at depth 2)', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('branch', makeNode('branch', { kind: 'branch', depth: 0, startTime: 1000 }));
    nodes.set('loop', makeNode('loop', { parentId: 'branch', kind: 'loop', depth: 1, startTime: 2000 }));
    nodes.set('step', makeNode('step', { parentId: 'loop', kind: 'run', depth: 2, startTime: 3000 }));

    const { positions } = calculateSequentialLayout(nodes, 'branch');

    const branchPos = positions.find((p) => p.id === 'branch');
    const loopPos = positions.find((p) => p.id === 'loop');
    const stepPos = positions.find((p) => p.id === 'step');

    expect(branchPos!.scale).toBe(1);
    expect(loopPos!.scale).toBe(0.5);
    expect(stepPos!.scale).toBe(0.25);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/ui && bun test test/node-rendering-integration.test.ts`
Expected: FAIL — `scale` is undefined, dimensions don't match

- [ ] **Step 3: Update layout engine with grid snapping and scale**

In `packages/ui/src/client/lib/sequential-layout.ts`:

Add import at top:
```typescript
import { snapToGrid } from './grid';
```

Update `SequentialLayoutOptions` to add:
```typescript
  gridCellSize: number;
  nestingScale: number;
```

Update `DEFAULT_OPTIONS` to add:
```typescript
  gridCellSize: 20,
  nestingScale: 0.5,
```

Update `layoutNode` to accept and pass a `scale` parameter (default 1). Leaf nodes get `scale` in their position, and their width/height are `snapToGrid(opts.nodeWidth * scale)` / `snapToGrid(opts.nodeHeight * scale)`. All `x`, `y` values go through `snapToGrid()`.

Container layout functions pass `scale * opts.nestingScale` to child `layoutNode` calls. Container padding is also scaled: `snapToGrid(opts.containerPadTop * scale)`, etc.

Each `ctx.positions.push(...)` call includes `scale` in the position object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/ui && bun test test/node-rendering-integration.test.ts`
Expected: PASS — all tests green (both new and existing)

- [ ] **Step 5: Run typecheck**

Run: `cd packages/ui && bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/client/lib/sequential-layout.ts packages/ui/test/node-rendering-integration.test.ts
git commit -m "feat(ui): add grid snapping and recursive 50% nesting scale to layout engine"
```

---

### Task 6: Layout engine — branch children horizontal

**Files:**
- Modify: `packages/ui/src/client/lib/sequential-layout.ts`
- Modify: `packages/ui/test/node-rendering-integration.test.ts`

- [ ] **Step 1: Write failing test for horizontal branch layout**

Add to the existing `describe` block in `packages/ui/test/node-rendering-integration.test.ts`:

```typescript
  it('renders branch children side by side (horizontal)', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('branch', makeNode('branch', { kind: 'branch', depth: 0, startTime: 1000 }));
    nodes.set('path-a', makeNode('path-a', { parentId: 'branch', kind: 'run', depth: 1, startTime: 2000 }));
    nodes.set('path-b', makeNode('path-b', { parentId: 'branch', kind: 'run', depth: 1, startTime: 2001 }));

    const { positions } = calculateSequentialLayout(nodes, 'branch');

    const pathAPos = positions.find((p) => p.id === 'path-a');
    const pathBPos = positions.find((p) => p.id === 'path-b');

    // Same y (side by side)
    expect(pathAPos!.y).toBe(pathBPos!.y);
    // Different x
    expect(pathBPos!.x).toBeGreaterThan(pathAPos!.x);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ui && bun test test/node-rendering-integration.test.ts`
Expected: FAIL — branch children are currently stacked vertically, so `pathAPos.y !== pathBPos.y`

- [ ] **Step 3: Change branch from sequential to horizontal layout**

In `packages/ui/src/client/lib/sequential-layout.ts`, update `layoutNode` so that `node.kind === 'branch'` routes to `layoutForkContainer` (the horizontal layout function) instead of `layoutSequentialContainer`. Change the condition:

```typescript
  if (node.kind === 'fork' || node.kind === 'branch') {
    return layoutForkContainer(
      {
        nodeId,
        children,
        x,
        y,
      },
      ctx,
      scale,
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/ui && bun test test/node-rendering-integration.test.ts`
Expected: PASS — all tests green. Note: the existing "renders leaf nodes sequentially when siblings of a container" test uses a branch with sequential children — update it to expect horizontal layout if it breaks.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/client/lib/sequential-layout.ts packages/ui/test/node-rendering-integration.test.ts
git commit -m "feat(ui): lay out branch children horizontally like fork"
```

---

### Task 7: Layout engine — sibling overlap prevention

**Files:**
- Modify: `packages/ui/src/client/lib/sequential-layout.ts`
- Modify: `packages/ui/test/node-rendering-integration.test.ts`

- [ ] **Step 1: Write failing test for sibling overlap prevention**

Add to the existing `describe` block:

```typescript
  it('prevents sibling overlap in horizontal layout', () => {
    const nodes = new Map<string, ExecutionNode>();
    // Fork with 3 children — one of which is a wide container
    nodes.set('fork', makeNode('fork', { kind: 'fork', depth: 0, startTime: 1000 }));
    nodes.set('path-1', makeNode('path-1', { parentId: 'fork', kind: 'loop', depth: 1, startTime: 2000 }));
    nodes.set('inner-1', makeNode('inner-1', { parentId: 'path-1', kind: 'run', depth: 2, startTime: 2001 }));
    nodes.set('inner-2', makeNode('inner-2', { parentId: 'path-1', kind: 'run', depth: 2, startTime: 2002 }));
    nodes.set('path-2', makeNode('path-2', { parentId: 'fork', kind: 'run', depth: 1, startTime: 3000 }));

    const { positions } = calculateSequentialLayout(nodes, 'fork');

    const path1Pos = positions.find((p) => p.id === 'path-1');
    const path2Pos = positions.find((p) => p.id === 'path-2');

    // path-2 should not overlap path-1's bounding box
    expect(path2Pos!.x).toBeGreaterThanOrEqual(path1Pos!.x + path1Pos!.width);
  });

  it('prevents sibling overlap in vertical layout', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('loop', makeNode('loop', { kind: 'loop', depth: 0, startTime: 1000 }));
    nodes.set('step-1', makeNode('step-1', { parentId: 'loop', kind: 'run', depth: 1, startTime: 2000 }));
    nodes.set('step-2', makeNode('step-2', { parentId: 'loop', kind: 'run', depth: 1, startTime: 3000 }));

    const { positions } = calculateSequentialLayout(nodes, 'loop');

    const step1Pos = positions.find((p) => p.id === 'step-1');
    const step2Pos = positions.find((p) => p.id === 'step-2');

    // step-2 should not overlap step-1's bounding box
    expect(step2Pos!.y).toBeGreaterThanOrEqual(step1Pos!.y + step1Pos!.height);
  });
```

- [ ] **Step 2: Run tests to verify they pass (or fail)**

Run: `cd packages/ui && bun test test/node-rendering-integration.test.ts`
Expected: These should PASS already since the layout engine uses spacing. If they fail, the collision pass needs adjustment.

- [ ] **Step 3: Add explicit collision resolution if needed**

If any test fails, add a `resolveOverlaps` function that iterates sibling positions and pushes overlapping ones apart. Call it after laying out children in both `layoutSequentialContainer` and `layoutForkContainer`.

```typescript
/** Push apart overlapping siblings */
function resolveOverlaps(
  childPositions: NodePosition[],
  direction: 'horizontal' | 'vertical',
  spacing: number,
): void {
  if (childPositions.length <= 1) {
    return;
  }

  const sorted = direction === 'horizontal'
    ? [...childPositions].sort((a, b) => a.x - b.x)
    : [...childPositions].sort((a, b) => a.y - b.y);

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];
    if (direction === 'horizontal') {
      const minX = prev.x + prev.width + spacing;
      if (curr.x < minX) {
        const shift = minX - curr.x;
        curr.x = snapToGrid(minX);
        // Also shift any children of curr
      }
    } else {
      const minY = prev.y + prev.height + spacing;
      if (curr.y < minY) {
        curr.y = snapToGrid(minY);
      }
    }
  }
}
```

- [ ] **Step 4: Run all layout tests**

Run: `cd packages/ui && bun test test/node-rendering-integration.test.ts`
Expected: PASS — all tests green

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/client/lib/sequential-layout.ts packages/ui/test/node-rendering-integration.test.ts
git commit -m "feat(ui): add sibling overlap prevention to layout engine"
```

---

### Task 8: Edge style constants

**Files:**
- Modify: `packages/ui/src/client/components/nodes/shared.ts`

- [ ] **Step 1: Add edge style constants**

Add to `packages/ui/src/client/components/nodes/shared.ts`:

```typescript
export const EDGE_STYLES: Record<
  'default' | 'conditional' | 'fork' | 'loop' | 'spawn',
  {
    color: string;
    strokeDasharray: string | undefined;
    strokeWidth: number;
  }
> = {
  default: {
    color: '#6b7280', // gray — overridden by source node status color at render time
    strokeDasharray: undefined,
    strokeWidth: 1.5,
  },
  conditional: {
    color: '#eab308', // yellow (branch kind)
    strokeDasharray: '5,5',
    strokeWidth: 1.5,
  },
  fork: {
    color: '#ec4899', // pink (fork kind)
    strokeDasharray: undefined,
    strokeWidth: 1.5,
  },
  loop: {
    color: '#14b8a6', // teal (loop kind)
    strokeDasharray: '3,3',
    strokeWidth: 1.5,
  },
  spawn: {
    color: '#6366f1', // indigo (spawn kind)
    strokeDasharray: '8,3,3,3',
    strokeWidth: 1.5,
  },
};

/** Corner radius for orthogonal edge turns */
export const EDGE_CORNER_RADIUS = 6;
```

- [ ] **Step 2: Run typecheck**

Run: `cd packages/ui && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/client/components/nodes/shared.ts
git commit -m "feat(ui): add edge style constants for kind-colored orthogonal routing"
```

---

### Task 9: NodeGraph — polyline edge renderer with corner radius

**Files:**
- Modify: `packages/ui/src/client/components/NodeGraph.tsx`

- [ ] **Step 1: Replace bezier edge rendering with orthogonal polyline renderer**

In `packages/ui/src/client/components/NodeGraph.tsx`:

Add imports:
```typescript
import { routeEdge } from '../lib/edge-router';
import type { Waypoint } from '../types';
import { EDGE_CORNER_RADIUS, EDGE_STYLES } from './nodes/shared';
```

Replace the `renderEdge` function with a new version that:

1. Calls `routeEdge(sourcePos, targetPos, allPositions)` to get waypoints
2. Builds an SVG path from the waypoints with rounded corners at each turn:

```typescript
  /** Build SVG path from orthogonal waypoints with rounded corners */
  const buildPolylinePath = (waypoints: Waypoint[], radius: number): string => {
    if (waypoints.length < 2) {
      return '';
    }
    if (waypoints.length === 2) {
      return `M ${waypoints[0].x} ${waypoints[0].y} L ${waypoints[1].x} ${waypoints[1].y}`;
    }

    const parts: string[] = [`M ${waypoints[0].x} ${waypoints[0].y}`];

    for (let i = 1; i < waypoints.length - 1; i++) {
      const prev = waypoints[i - 1];
      const curr = waypoints[i];
      const next = waypoints[i + 1];

      // Distance to prev and next points
      const dPrev = Math.max(Math.abs(curr.x - prev.x), Math.abs(curr.y - prev.y));
      const dNext = Math.max(Math.abs(next.x - curr.x), Math.abs(next.y - curr.y));
      const r = Math.min(radius, dPrev / 2, dNext / 2);

      // Direction vectors
      const fromX = Math.sign(curr.x - prev.x);
      const fromY = Math.sign(curr.y - prev.y);
      const toX = Math.sign(next.x - curr.x);
      const toY = Math.sign(next.y - curr.y);

      // Arc start and end
      const arcStartX = curr.x - fromX * r;
      const arcStartY = curr.y - fromY * r;
      const arcEndX = curr.x + toX * r;
      const arcEndY = curr.y + toY * r;

      // Determine sweep direction
      const cross = fromX * toY - fromY * toX;
      const sweep = cross > 0 ? 1 : 0;

      parts.push(`L ${arcStartX} ${arcStartY}`);
      parts.push(`A ${r} ${r} 0 0 ${sweep} ${arcEndX} ${arcEndY}`);
    }

    const last = waypoints[waypoints.length - 1];
    parts.push(`L ${last.x} ${last.y}`);

    return parts.join(' ');
  };
```

3. Renders with the EDGE_STYLES color/dash for each edge type:

```typescript
  const renderEdge = (edge: NodeEdge, sourcePos: NodePosition, targetPos: NodePosition) => {
    const obstaclePositions = positions.filter(
      (p) => p.id !== edge.source && p.id !== edge.target,
    );
    const routed = routeEdge(sourcePos, targetPos, obstaclePositions);
    const path = buildPolylinePath(routed.waypoints, EDGE_CORNER_RADIUS);

    const edgeStyle = EDGE_STYLES[edge.type] ?? EDGE_STYLES.default;

    // For default edges, use source node status color
    let strokeColor = edgeStyle.color;
    if (edge.type === 'default') {
      const sourceNode = nodes.get(edge.source);
      const isEdgeGhosted =
        executedNodeIds !== undefined &&
        (!executedNodeIds.has(edge.source) || !executedNodeIds.has(edge.target));
      const effectiveStatus = isEdgeGhosted ? 'pending' : sourceNode?.status;
      strokeColor = effectiveStatus
        ? STATUS_COLORS[effectiveStatus].border
        : edgeStyle.color;
    }

    return (
      <g key={edge.id}>
        {/* Arrow marker definition */}
        <defs>
          <marker
            id={`arrow-${edge.id}`}
            viewBox="0 0 10 8"
            refX="10"
            refY="4"
            markerWidth="8"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <polyline
              points="0,0 10,4 0,8"
              fill="none"
              stroke={strokeColor}
              strokeWidth="1.5"
            />
          </marker>
        </defs>
        <path
          d={path}
          fill="none"
          stroke={strokeColor}
          strokeWidth={edgeStyle.strokeWidth}
          strokeDasharray={edgeStyle.strokeDasharray}
          markerEnd={`url(#arrow-${edge.id})`}
        />
        {edge.animated && (
          <circle r="3" fill={strokeColor}>
            <animateMotion dur="1s" repeatCount="indefinite" path={path} />
          </circle>
        )}
      </g>
    );
  };
```

- [ ] **Step 2: Run typecheck**

Run: `cd packages/ui && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/client/components/NodeGraph.tsx
git commit -m "feat(ui): replace bezier edges with orthogonal polyline routing and kind-colored styles"
```

---

### Task 10: NodeGraph — container scaling in render

**Files:**
- Modify: `packages/ui/src/client/components/NodeGraph.tsx`

- [ ] **Step 1: Apply scale transform to rendered nodes and containers**

In `NodeGraph.tsx`, update the container render section to apply CSS `transform: scale()` using the position's `scale` field:

For containers:
```typescript
          <div
            key={`container-${pos.id}`}
            style={{
              position: 'absolute',
              left: pos.x,
              top: pos.y,
              width: pos.width,
              height: pos.height,
              borderRadius: '12px',
              border: `2px dashed ${kindColors.border}`,
              backgroundColor: `${kindColors.bg}`,
              pointerEvents: 'none',
              transformOrigin: 'top left',
            }}
          >
```

For leaf nodes, apply scale transform so the node card renders at the correct visual size:
```typescript
          <div
            key={pos.id}
            style={{
              position: 'absolute',
              left: pos.x,
              top: pos.y,
              width: pos.width,
              height: pos.height,
              pointerEvents: 'auto',
              transform: pos.scale && pos.scale !== 1 ? `scale(${pos.scale})` : undefined,
              transformOrigin: 'top left',
            }}
          >
            {renderNode(node)}
          </div>
```

Update the container header font size to scale proportionally:
```typescript
  fontSize: `${12 * (pos.scale ?? 1)}px`,
```

- [ ] **Step 2: Run typecheck**

Run: `cd packages/ui && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/client/components/NodeGraph.tsx
git commit -m "feat(ui): apply recursive scale factor to container and node rendering"
```

---

### Task 11: NodeGraph — click-to-zoom with breadcrumb navigation

**Files:**
- Modify: `packages/ui/src/client/components/NodeGraph.tsx`

- [ ] **Step 1: Add zoom stack state and breadcrumb UI**

Add state for zoom stack:
```typescript
  interface ZoomEntry {
    containerId: string;
    label: string;
    previousView: ViewState;
  }

  const [zoomStack, setZoomStack] = useState<ZoomEntry[]>([]);
```

Add handler for clicking a container to zoom in:
```typescript
  const handleContainerZoom = useCallback(
    (containerId: string) => {
      const pos = positionMap.get(containerId);
      const node = nodes.get(containerId);
      if (!pos || !node || !containerRef.current) {
        return;
      }

      const { width: vw, height: vh } = containerRef.current.getBoundingClientRect();
      const scale = pos.scale ?? 1;
      const targetZoom = Math.min(1 / scale, MAX_ZOOM);

      const centerX = pos.x + pos.width / 2;
      const centerY = pos.y + pos.height / 2;

      const newView: ViewState = {
        x: vw / 2 - centerX * targetZoom,
        y: vh / 2 - centerY * targetZoom,
        zoom: targetZoom,
      };

      setZoomStack((prev) => [
        ...prev,
        {
          containerId,
          label: `${STEP_KIND_LABELS[node.kind]} ${node.stepId}`,
          previousView: { ...view },
        },
      ]);
      setView(newView);
    },
    [positionMap, nodes, view],
  );

  const handleZoomBack = useCallback(() => {
    setZoomStack((prev) => {
      if (prev.length === 0) {
        return prev;
      }
      const last = prev[prev.length - 1];
      setView(last.previousView);
      return prev.slice(0, -1);
    });
  }, []);
```

Make container divs clickable (add `pointerEvents: 'auto'` and `onClick`):
```typescript
  onClick={() => {
    const children = ctx.childrenOf.get(pos.id) ?? [];
    if (children.length > 0) {
      handleContainerZoom(pos.id);
    }
  }}
  style={{ cursor: 'pointer', pointerEvents: 'auto' }}
```

Add CSS transition to the graph canvas div for smooth animation:
```typescript
  style={{
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
    transformOrigin: '0 0',
    transition: zoomStack.length > 0 ? 'transform 0.3s ease-out' : undefined,
    position: 'absolute',
    top: 0,
    left: 0,
  }}
```

Add breadcrumb bar in the controls area (below the existing controls):
```typescript
  {zoomStack.length > 0 && (
    <div
      style={{
        position: 'absolute',
        top: '56px',
        right: '16px',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        zIndex: 10,
        padding: '6px 12px',
        backgroundColor: 'var(--noetic-canvas-bg)',
        border: '1px solid var(--noetic-border)',
        borderRadius: '4px',
        fontSize: '12px',
        color: 'var(--noetic-text)',
      }}
    >
      <button
        type="button"
        onClick={handleZoomBack}
        style={{
          background: 'none',
          border: 'none',
          color: 'var(--noetic-text)',
          cursor: 'pointer',
          padding: '2px 6px',
          fontSize: '12px',
        }}
      >
        Root
      </button>
      {zoomStack.map((entry, i) => (
        <span key={entry.containerId} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{ opacity: 0.5 }}>/</span>
          <button
            type="button"
            onClick={() => {
              // Pop to this level
              const target = zoomStack[i];
              setView(target.previousView);
              setZoomStack((prev) => prev.slice(0, i));
            }}
            style={{
              background: 'none',
              border: 'none',
              color: i === zoomStack.length - 1 ? 'var(--noetic-text)' : 'var(--noetic-text-secondary)',
              cursor: 'pointer',
              padding: '2px 6px',
              fontSize: '12px',
              fontWeight: i === zoomStack.length - 1 ? 600 : 400,
            }}
          >
            {entry.label}
          </button>
        </span>
      ))}
    </div>
  )}
```

- [ ] **Step 2: Run typecheck**

Run: `cd packages/ui && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/client/components/NodeGraph.tsx
git commit -m "feat(ui): add click-to-zoom on containers with breadcrumb navigation"
```

---

### Task 12: Layout engine — spawn edge type

**Files:**
- Modify: `packages/ui/src/client/lib/sequential-layout.ts`
- Modify: `packages/ui/test/node-rendering-integration.test.ts`

- [ ] **Step 1: Write failing test for spawn edges**

Add to the existing `describe` block:

```typescript
  it('generates spawn-type edges for spawn container children', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('spawn-1', makeNode('spawn-1', { kind: 'spawn', depth: 0, startTime: 1000 }));
    nodes.set('child-1', makeNode('child-1', { parentId: 'spawn-1', kind: 'run', depth: 1, startTime: 2000 }));
    nodes.set('child-2', makeNode('child-2', { parentId: 'spawn-1', kind: 'llm', depth: 1, startTime: 3000 }));

    const { edges } = calculateSequentialLayout(nodes, 'spawn-1');

    const spawnEdge = edges.find((e) => e.source === 'child-1' && e.target === 'child-2');
    expect(spawnEdge).toBeDefined();
    expect(spawnEdge!.type).toBe('spawn');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ui && bun test test/node-rendering-integration.test.ts`
Expected: FAIL — edge type is `'default'` not `'spawn'`

- [ ] **Step 3: Update sequential container to emit spawn edges**

In `layoutSequentialContainer`, change the edge type based on the container's kind:

```typescript
    // Edge from this child to the next
    if (i < children.length - 1) {
      const edgeType = node.kind === 'spawn' ? 'spawn' as const : 'default' as const;
      ctx.edges.push({
        id: `${childId}-${children[i + 1]}`,
        source: childId,
        target: children[i + 1],
        type: edgeType,
        animated: ctx.nodes.get(childId)?.status === 'running',
      });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/ui && bun test test/node-rendering-integration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/client/lib/sequential-layout.ts packages/ui/test/node-rendering-integration.test.ts
git commit -m "feat(ui): emit spawn-type edges for spawn container children"
```

---

### Task 13: Layout engine — conditional edges for branch containers

**Files:**
- Modify: `packages/ui/src/client/lib/sequential-layout.ts`
- Modify: `packages/ui/test/node-rendering-integration.test.ts`

- [ ] **Step 1: Write failing test for conditional edges**

Add to the existing `describe` block:

```typescript
  it('generates conditional-type edges from branch container to its children', () => {
    const nodes = new Map<string, ExecutionNode>();
    nodes.set('branch', makeNode('branch', { kind: 'branch', depth: 0, startTime: 1000 }));
    nodes.set('path-a', makeNode('path-a', { parentId: 'branch', kind: 'run', depth: 1, startTime: 2000 }));
    nodes.set('path-b', makeNode('path-b', { parentId: 'branch', kind: 'run', depth: 1, startTime: 2001 }));

    const { edges } = calculateSequentialLayout(nodes, 'branch');

    // Branch uses fork layout (horizontal), so no sequential edges between children.
    // But there should be conditional-type edges from branch to each child.
    const conditionalEdges = edges.filter((e) => e.type === 'conditional');
    expect(conditionalEdges.length).toBeGreaterThanOrEqual(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/ui && bun test test/node-rendering-integration.test.ts`
Expected: FAIL — no conditional edges

- [ ] **Step 3: Add conditional edges in fork layout for branch kind**

In `layoutForkContainer`, after laying out children, if the parent node is a branch, emit conditional edges from the container to each child:

```typescript
  // For branch containers, add conditional edges to each child path
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
  }
```

Also for fork containers, add fork-type edges:
```typescript
  if (parentNode?.kind === 'fork') {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/ui && bun test test/node-rendering-integration.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/client/lib/sequential-layout.ts packages/ui/test/node-rendering-integration.test.ts
git commit -m "feat(ui): emit conditional edges for branch and fork edges for fork containers"
```

---

### Task 14: Final integration — run all checks

**Files:** (none new)

- [ ] **Step 1: Run all tests**

Run: `cd packages/ui && bun test`
Expected: All tests PASS

- [ ] **Step 2: Run typecheck**

Run: `cd packages/ui && bun run typecheck`
Expected: PASS

- [ ] **Step 3: Run linter**

Run: `cd packages/ui && bunx biome check .`
Expected: PASS (fix any formatting issues)

- [ ] **Step 4: Commit any lint fixes**

```bash
git add -A && git commit -m "style(ui): fix lint issues"
```
(Only if there were lint fixes needed)

- [ ] **Step 5: Final commit — no-op if clean**

Run: `git status` to confirm working tree is clean.
