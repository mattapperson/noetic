/**
 * Formatting helpers for the resume picker. Hand-rolled to avoid pulling in
 * `date-fns` / `dayjs` / similar.
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export function formatRelativeTimeAgo(isoOrDate: string | Date, now: Date = new Date()): string {
  const then = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
  const delta = now.getTime() - then.getTime();
  if (Number.isNaN(delta) || delta < 0) {
    return 'just now';
  }
  if (delta < 10 * SECOND) {
    return 'just now';
  }
  if (delta < MINUTE) {
    return `${Math.floor(delta / SECOND)}s ago`;
  }
  if (delta < HOUR) {
    return `${Math.floor(delta / MINUTE)}m ago`;
  }
  if (delta < DAY) {
    return `${Math.floor(delta / HOUR)}h ago`;
  }
  if (delta < WEEK) {
    return `${Math.floor(delta / DAY)}d ago`;
  }
  const month = then.toLocaleString('en-US', {
    month: 'short',
  });
  const day = then.getDate();
  if (now.getFullYear() === then.getFullYear()) {
    return `${month} ${day}`;
  }
  return `${month} ${day}, ${then.getFullYear()}`;
}

export function truncateFirstPrompt(raw: string, max = 120): string {
  const flattened = raw.replace(/\s+/g, ' ').trim();
  if (flattened.length <= max) {
    return flattened;
  }
  return `${flattened.slice(0, max - 1)}…`;
}
