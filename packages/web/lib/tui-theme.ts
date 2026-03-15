import type { CSSProperties } from 'react';

export const BOX = {
  topLeft: '\u250c',
  topRight: '\u2510',
  bottomLeft: '\u2514',
  bottomRight: '\u2518',
  horizontal: '\u2500',
  vertical: '\u2502',
} as const;

export const FRAME_FILL = BOX.horizontal.repeat(48);
export const FRAME_TITLE_FILL = BOX.horizontal.repeat(40);
export const FOOTER_RULE = BOX.horizontal.repeat(80);

export const GITHUB_URL = 'https://github.com/anthropics/orchid';

export const WINDOW_DOT_RED = '#ff5f56';
export const WINDOW_DOT_YELLOW = '#ffbd2e';
export const WINDOW_DOT_GREEN = '#27c93f';

export const NAV_BG = 'rgba(5, 5, 5, 0.8)';

export const HOVER_BG = {
  backgroundColor: 'var(--color-tui-surface-hover)',
} as const;

export const NAV_LINK_STYLE: CSSProperties = {
  fontSize: '13px',
  color: 'var(--color-tui-secondary)',
  textDecoration: 'none',
};

export const CODE_PRE_STYLE: CSSProperties = {
  margin: 0,
  fontSize: '13px',
  lineHeight: 1.7,
  color: 'var(--color-tui-secondary)',
  overflow: 'auto',
};

export const PRIMITIVE_COLORS = {
  run: 'tui-cyan',
  llm: 'tui-green',
  tool: 'tui-amber',
  branch: 'tui-cyan',
  fork: 'tui-cyan',
  spawn: 'tui-green',
  loop: 'tui-amber',
} as const satisfies Record<string, string>;

export type PrimitiveName = keyof typeof PRIMITIVE_COLORS;
