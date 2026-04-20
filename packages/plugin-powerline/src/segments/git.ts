import type { Segment } from './types.js';

export const gitSegment: Segment = ({ git, theme, icons }) => {
  if (!git) {
    return null;
  }
  const dirty = git.staged + git.unstaged + git.untracked > 0;
  const suffix = dirty ? '*' : '';
  const icon = dirty ? icons.gitDirty : icons.git;
  const labelParts: string[] = [];
  if (icon) {
    labelParts.push(icon);
  }
  labelParts.push(`${git.branch}${suffix}`);
  return {
    text: labelParts.join(' '),
    fg: theme.fgOnDark,
    bg: dirty ? theme.gitDirty : theme.git,
  };
};
