/**
 * Path helpers for the Mirage-backed adapters.
 *
 * These utilities only deal with string-level POSIX semantics — they
 * do NOT touch the real filesystem. The Mirage Workspace is responsible
 * for resolving paths against mounts.
 */

/** Quote a path for safe interpolation into a shell command. */
export function shellQuote(value: string): string {
  // Single-quote wrapping escapes everything except literal single quotes.
  // Rewrite `'` as `'\''` so the quoted segment closes, inserts an escaped
  // quote, and reopens.
  return `'${value.replace(/'/g, "'\\''")}'`;
}
