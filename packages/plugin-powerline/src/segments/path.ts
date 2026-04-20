import { homedir } from 'node:os';

import type { Segment } from './types.js';

const MAX_SEGMENTS = 3;

export const pathSegment: Segment = ({ ctx, theme, icons }) => ({
  text: icons.path ? `${icons.path} ${shorten(ctx.cwd)}` : shorten(ctx.cwd),
  fg: theme.fgOnDark,
  bg: theme.path,
});

function shorten(cwd: string): string {
  const home = homedir();
  const withTilde = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  const parts = withTilde.split('/').filter(Boolean);
  if (parts.length <= MAX_SEGMENTS) {
    return withTilde.startsWith('/') ? `/${parts.join('/')}` : parts.join('/');
  }
  const tail = parts.slice(-MAX_SEGMENTS).join('/');
  const head = parts[0] === '~' ? '~' : '…';
  return `${head}/${tail}`;
}
