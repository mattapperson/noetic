import stringWidth from 'string-width';

const ASCII_PADDING_WIDTH = 2;

export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return '';
  }
  if (stringWidth(text) <= maxWidth) {
    return text;
  }
  let used = 0;
  let take = 0;
  for (const ch of text) {
    const w = stringWidth(ch);
    if (used + w > maxWidth) {
      break;
    }
    used += w;
    take += 1;
  }
  return [
    ...text,
  ]
    .slice(0, take)
    .join('');
}

export interface FitSegmentsArgs<T> {
  cells: ReadonlyArray<T>;
  toText: (cell: T) => string;
  withText: (cell: T, text: string) => T;
  sepBetween: number;
  sepTrailing: number;
  budget: number;
}

/**
 * Fit segment cells into a horizontal width budget so the rendered footer
 * never exceeds the terminal width and never soft-wraps.
 *
 * Why this exists: Ink's frame-erase counts logical newlines and ignores
 * terminal soft-wrap (vadimdemedes/ink#907). When a footer line is wider
 * than `stdout.columns`, the terminal wraps it onto extra rows but Ink
 * still erases only one row on the next render, leaving stale content in
 * scrollback on every keystroke.
 */
export function fitSegments<T>({
  cells,
  toText,
  withText,
  sepBetween,
  sepTrailing,
  budget,
}: FitSegmentsArgs<T>): T[] {
  if (budget <= 0 || cells.length === 0) {
    return [];
  }
  const fitted: T[] = [];
  let used = 0;
  for (const cell of cells) {
    const cellCost = stringWidth(` ${toText(cell)} `);
    const sepBefore = fitted.length > 0 ? sepBetween : 0;
    if (used + sepBefore + cellCost + sepTrailing > budget) {
      break;
    }
    used += sepBefore + cellCost;
    fitted.push(cell);
  }
  if (fitted.length > 0) {
    return fitted;
  }
  const first = cells[0];
  if (first === undefined) {
    return [];
  }
  const textBudget = budget - sepTrailing - ASCII_PADDING_WIDTH;
  if (textBudget <= 0) {
    return [];
  }
  return [
    withText(first, truncateToWidth(toText(first), textBudget)),
  ];
}
