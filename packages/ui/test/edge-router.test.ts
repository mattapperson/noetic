import { describe, expect, it } from 'bun:test';
import { routeEdge } from '../src/client/lib/edge-router';
import type { NodePosition } from '../src/client/types';

function makePos(id: string, x: number, y: number): NodePosition {
  return {
    id,
    x,
    y,
    width: 280,
    height: 140,
  };
}

describe('routeEdge — A* obstacle avoidance', () => {
  it('routes around an obstacle between source and target', () => {
    // Source bottom-center: (240, 240), Target top-center: (240, 500)
    // Direct vertical route passes through x=240, y in [240, 500]
    // Obstacle at (80, 280) spans x=[80,360] (includes 240) and y=[280,420]
    const source = makePos('a', 100, 100);
    const target = makePos('b', 100, 500);
    const obstacle = makePos('blocker', 80, 280);
    const result = routeEdge(source, target, [
      obstacle,
    ]);

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
        const obstacleTop = obstacle.y - 10;
        const obstacleBottom = obstacle.y + obstacle.height + 10;
        const overlaps = maxY > obstacleTop && minY < obstacleBottom;
        expect(overlaps).toBe(false);
      }
    }
  });

  it('routes around multiple obstacles', () => {
    // Source bottom-center: (240, 240), Target top-center: (240, 700)
    // obs1 at (80, 280) spans y=[280,420], obs2 at (80, 480) spans y=[480,620]
    const source = makePos('a', 100, 100);
    const target = makePos('b', 100, 700);
    const obs1 = makePos('obs1', 80, 280);
    const obs2 = makePos('obs2', 80, 480);
    const result = routeEdge(source, target, [
      obs1,
      obs2,
    ]);

    // All segments axis-aligned
    for (let i = 0; i < result.waypoints.length - 1; i++) {
      const a = result.waypoints[i];
      const b = result.waypoints[i + 1];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }

    // Route should have more than 2 waypoints (forced to go around)
    expect(result.waypoints.length).toBeGreaterThan(2);
  });
});

describe('routeEdge — anchor selection (4-sided)', () => {
  it('picks bottom/top anchors when nodes are vertically stacked', () => {
    const source = makePos('a', 100, 100);
    const target = makePos('b', 100, 400);
    const result = routeEdge(source, target, []);

    // Straight vertical line: bottom-center of source → top-center of target
    expect(result.waypoints).toHaveLength(2);
    expect(result.waypoints[0].x).toBe(240); // cx = 100 + 280/2
    expect(result.waypoints[0].y).toBe(240); // bottom edge = 100 + 140
    expect(result.waypoints[1].x).toBe(240);
    expect(result.waypoints[1].y).toBe(400); // top edge of target
  });

  it('picks right/left anchors when nodes are side-by-side', () => {
    const source = makePos('a', 0, 0);
    const target = makePos('b', 500, 0);
    const result = routeEdge(source, target, []);

    // Straight horizontal line: right-center of source → left-center of target
    expect(result.waypoints).toHaveLength(2);
    expect(result.waypoints[0].x).toBe(280); // right edge = 0 + 280
    expect(result.waypoints[0].y).toBe(70); // cy = 0 + 140/2
    expect(result.waypoints[1].x).toBe(500); // left edge of target
    expect(result.waypoints[1].y).toBe(70);
  });

  it('picks the side with the largest gap for diagonal placement', () => {
    // Source at (100,100), target at (400,300)
    // Vertical gap: 300 - 240 = 60, Horizontal gap: 400 - 380 = 20
    // Should pick bottom/top (larger gap)
    const source = makePos('a', 100, 100);
    const target = makePos('b', 400, 300);
    const result = routeEdge(source, target, []);

    // First point should be bottom-center of source
    expect(result.waypoints[0]).toEqual({ x: 240, y: 240 });
    // Last point should be top-center of target
    const last = result.waypoints[result.waypoints.length - 1];
    expect(last).toEqual({ x: 540, y: 300 });
  });

  it('falls back to least-negative gap when nodes overlap', () => {
    // Overlapping nodes — should still produce a valid route
    const source = makePos('a', 0, 0);
    const target = makePos('b', 100, 50);
    const result = routeEdge(source, target, []);

    expect(result.waypoints.length).toBeGreaterThanOrEqual(2);
    // All segments axis-aligned
    for (let i = 0; i < result.waypoints.length - 1; i++) {
      const a = result.waypoints[i];
      const b = result.waypoints[i + 1];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });
});

describe('routeEdge — simple route shapes', () => {
  it('produces L-shape for mixed vertical/horizontal anchors', () => {
    // Source far above and to the left, target far to the right
    // Vertical gap: negative, Horizontal gap: large → right/left anchors on one
    // but vertical gap larger on other → mixed anchors possible
    const source = makePos('a', 0, 0);
    const target = makePos('b', 600, 200);
    const result = routeEdge(source, target, []);

    // Should have at least 2 waypoints and all axis-aligned
    expect(result.waypoints.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < result.waypoints.length - 1; i++) {
      const a = result.waypoints[i];
      const b = result.waypoints[i + 1];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });

  it('produces Z-shape for horizontal anchors at different y-levels', () => {
    // Nodes at same y but far apart should use right/left anchors
    const source = makePos('a', 0, 0);
    const target = makePos('b', 600, 200);
    const result = routeEdge(source, target, []);

    expect(result.waypoints.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < result.waypoints.length - 1; i++) {
      const a = result.waypoints[i];
      const b = result.waypoints[i + 1];
      expect(a.x === b.x || a.y === b.y).toBe(true);
    }
  });
});

describe('routeEdge — simple rules', () => {
  it('routes straight down when source is directly above target', () => {
    const source = makePos('a', 100, 100);
    const target = makePos('b', 100, 300);
    const result = routeEdge(source, target, []);

    // Should have exactly 2 waypoints: bottom-center of source, top-center of target
    expect(result.waypoints).toHaveLength(2);
    expect(result.waypoints[0]).toEqual({
      x: 240,
      y: 240,
    }); // 100 + 280/2, 100 + 140
    expect(result.waypoints[1]).toEqual({
      x: 240,
      y: 300,
    }); // 100 + 280/2, 300
  });

  it('routes with one horizontal jog when nodes are offset horizontally', () => {
    const source = makePos('a', 100, 100);
    const target = makePos('b', 400, 300);
    const result = routeEdge(source, target, []);

    // bottom-center of source → down → horizontal jog → down → top-center of target
    expect(result.waypoints.length).toBeGreaterThanOrEqual(4);
    // First point: bottom-center of source
    expect(result.waypoints[0]).toEqual({
      x: 240,
      y: 240,
    });
    // Last point: top-center of target
    const last = result.waypoints[result.waypoints.length - 1];
    expect(last).toEqual({
      x: 540,
      y: 300,
    });
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
