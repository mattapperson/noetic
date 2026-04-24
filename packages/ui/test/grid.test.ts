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
