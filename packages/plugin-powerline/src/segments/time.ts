import type { Segment } from './types.js';

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1e3));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, '0')}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, '0')}s`;
  }
  return `${seconds}s`;
}

export const sessionTimeSegment: Segment = ({ ctx, theme, icons, now }) => {
  const elapsed = now - ctx.sessionStartedAt;
  const text = icons.stopwatch
    ? `${icons.stopwatch} ${formatDuration(elapsed)}`
    : formatDuration(elapsed);
  return {
    text,
    fg: theme.fg,
    bg: theme.time,
  };
};

export const clockSegment: Segment = ({ theme, icons, now }) => {
  const date = new Date(now);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const text = icons.clock ? `${icons.clock} ${hh}:${mm}` : `${hh}:${mm}`;
  return {
    text,
    fg: theme.fg,
    bg: theme.time,
  };
};
