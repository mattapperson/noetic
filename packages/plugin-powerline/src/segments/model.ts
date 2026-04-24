import type { Segment } from './types.js';

export const modelSegment: Segment = ({ ctx, theme, icons }) => {
  const bare = ctx.model.replace(/^[^/]+\//, '');
  const text = icons.model ? `${icons.model} ${bare}` : bare;
  return {
    text,
    fg: theme.fgOnDark,
    bg: theme.model,
  };
};
