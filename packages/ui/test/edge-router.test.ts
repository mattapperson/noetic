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
