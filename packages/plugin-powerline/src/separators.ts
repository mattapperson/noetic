/**
 * Segment separators. Powerline glyphs render as a continuous arrow between
 * adjacent background-colored cells; plain characters work in any terminal.
 */

export interface SeparatorSet {
  readonly main: string;
  readonly thin: string;
}

export const POWERLINE_SEPARATORS: SeparatorSet = {
  main: '\uE0B0',
  thin: '\uE0B1',
};

export const ASCII_SEPARATORS: SeparatorSet = {
  main: '>',
  thin: '|',
};

export function resolveSeparators(nerd: boolean): SeparatorSet {
  return nerd ? POWERLINE_SEPARATORS : ASCII_SEPARATORS;
}
