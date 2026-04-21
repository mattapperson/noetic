import type { Segment } from './types.js';

export const noeticSegment: Segment = ({ theme, icons }) => ({
  text: icons.noetic,
  fg: theme.fgOnDark,
  bg: theme.noetic,
  bold: true,
});
