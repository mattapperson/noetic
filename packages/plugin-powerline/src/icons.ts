/**
 * Nerd Font icon set with ASCII fallbacks.
 *
 * When Nerd Fonts are unavailable (detected at init, or forced off via the
 * `nerdFonts: 'off'` option) we substitute text glyphs so the footer stays
 * legible on any terminal.
 */

export interface IconSet {
  readonly noetic: string;
  readonly model: string;
  readonly path: string;
  readonly git: string;
  readonly gitDirty: string;
  readonly tokens: string;
  readonly context: string;
  readonly clock: string;
  readonly stopwatch: string;
}

export const NERD_ICONS: IconSet = {
  noetic: '\u{f0ed0}',
  model: '\u{f0684}',
  path: '\u{f07b}',
  git: '\u{e725}',
  gitDirty: '\u{f44c}',
  tokens: '\u{f4bc}',
  context: '\u{f2db}',
  clock: '\u{f017}',
  stopwatch: '\u{f0fde}',
};

export const ASCII_ICONS: IconSet = {
  noetic: 'N',
  model: '*',
  path: '~',
  git: '',
  gitDirty: '±',
  tokens: '#',
  context: '%',
  clock: '@',
  stopwatch: 't',
};

export function resolveIcons(nerd: boolean): IconSet {
  return nerd ? NERD_ICONS : ASCII_ICONS;
}
