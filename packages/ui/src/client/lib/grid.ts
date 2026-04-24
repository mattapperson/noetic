/** Default virtual grid cell size in pixels */
export const GRID_CELL_SIZE = 20;

/** Snap a value to the nearest grid cell boundary */
export function snapToGrid(value: number, cellSize: number = GRID_CELL_SIZE): number {
  const snapped = Math.round(value / cellSize) * cellSize;
  return snapped === 0 ? 0 : snapped;
}

/** Snap a value up to the next grid cell boundary (guarantees value never shrinks) */
export function snapToGridCeil(value: number, cellSize: number = GRID_CELL_SIZE): number {
  return Math.ceil(value / cellSize) * cellSize;
}
