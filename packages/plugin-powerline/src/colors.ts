/**
 * Named color palette. Values are CSS hex strings rendered by Ink as truecolor
 * where supported; terminals without truecolor will quantize to the nearest
 * 16/256 color.
 */

export const PALETTE = {
  bg: '#1a1b26',
  fg: '#c0caf5',
  muted: '#565f89',
  accent: '#7aa2f7',
  noetic: '#bb9af7',
  model: '#7dcfff',
  path: '#9ece6a',
  git: '#e0af68',
  gitDirty: '#f7768e',
  tokens: '#7dcfff',
  context: '#9ece6a',
  contextWarn: '#e0af68',
  contextCrit: '#f7768e',
  time: '#565f89',
  fgOnDark: '#1a1b26',
  separator: '#24283b',
} as const;

export type PaletteKey = keyof typeof PALETTE;

/** Tokyonight-inspired defaults; user theme.json overrides individual keys. */
export const DEFAULT_THEME: Record<PaletteKey, string> = {
  ...PALETTE,
};
