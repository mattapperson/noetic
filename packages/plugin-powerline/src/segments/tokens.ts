import type { LastLayerUsage } from '@noetic/core';

import type { Segment } from './types.js';

function formatK(n: number): string {
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(1)}k`;
  }
  return String(n);
}

function tokensUsed(usage: LastLayerUsage): number {
  return usage.totalUsedTokens;
}

export const tokensSegment: Segment = ({ ctx, theme, icons }) => {
  if (!ctx.lastLayerUsage) {
    return null;
  }
  const used = tokensUsed(ctx.lastLayerUsage);
  const text = icons.tokens
    ? `${icons.tokens} ${formatK(used)}/${formatK(ctx.contextLimit)}`
    : `${formatK(used)}/${formatK(ctx.contextLimit)}`;
  return {
    text,
    fg: theme.fgOnDark,
    bg: theme.tokens,
  };
};

export const contextPctSegment: Segment = ({ ctx, theme, icons }) => {
  if (!ctx.lastLayerUsage) {
    return null;
  }
  const used = tokensUsed(ctx.lastLayerUsage);
  const pct = ctx.contextLimit > 0 ? (used / ctx.contextLimit) * 1e2 : 0;
  const bg = pct >= 9e1 ? theme.contextCrit : pct >= 7e1 ? theme.contextWarn : theme.context;
  const text = icons.context ? `${icons.context} ${pct.toFixed(0)}%` : `${pct.toFixed(0)}%`;
  return {
    text,
    fg: theme.fgOnDark,
    bg,
  };
};
