/**
 * POSIX path helpers for the portable task store. Keeps the SDK free of
 * `node:path` so it runs anywhere — every path inside `.noetic/tasks/`
 * is forward-slash shaped, so POSIX semantics are correct.
 *
 * Windows callers that need backslash-shaped absolute roots should
 * normalise at the CLI boundary; nothing inside the task system is
 * meant to produce Windows-style `C:\` paths.
 */

//#region Helpers

function trimTrailing(segment: string): string {
  if (segment.length === 0) {
    return segment;
  }
  let end = segment.length;
  while (end > 1 && segment[end - 1] === '/') {
    end -= 1;
  }
  return segment.slice(0, end);
}

function splitSegments(p: string): string[] {
  return p.split('/').filter((segment) => segment.length > 0);
}

//#endregion

//#region Public API

/**
 * Join path segments with `/`. Matches `node:path.posix.join`: leading
 * slashes on later segments are absorbed — they do NOT reset the path.
 * `resolve` is the one that resets on absolute segments.
 */
export function join(...parts: ReadonlyArray<string>): string {
  const pieces: string[] = [];
  for (const raw of parts) {
    if (raw.length === 0) {
      continue;
    }
    pieces.push(raw);
  }
  if (pieces.length === 0) {
    return '.';
  }
  const joined = pieces
    .map((piece, i) => {
      if (i === 0) {
        return trimTrailing(piece);
      }
      return piece.replace(/^\/+/, '').replace(/\/+$/, '');
    })
    .filter((piece, i) => i === 0 || piece.length > 0)
    .join('/');
  return joined.length === 0 ? '.' : joined;
}

/** POSIX `dirname`: the directory portion of a path. */
export function dirname(p: string): string {
  if (p.length === 0) {
    return '.';
  }
  const trimmed = trimTrailing(p);
  if (trimmed === '/') {
    return '/';
  }
  const idx = trimmed.lastIndexOf('/');
  if (idx === -1) {
    return '.';
  }
  if (idx === 0) {
    return '/';
  }
  return trimmed.slice(0, idx);
}

/**
 * POSIX `basename`. If `ext` is provided and `name` ends with it, strip
 * the suffix (matching `node:path` semantics).
 */
export function basename(p: string, ext?: string): string {
  if (p.length === 0) {
    return '';
  }
  const trimmed = trimTrailing(p);
  const idx = trimmed.lastIndexOf('/');
  const name = idx === -1 ? trimmed : trimmed.slice(idx + 1);
  if (ext !== undefined && ext.length > 0 && name.endsWith(ext) && name !== ext) {
    return name.slice(0, name.length - ext.length);
  }
  return name;
}

/**
 * POSIX `resolve`: resolve segments to an absolute path relative to a
 * provided base (typically `cwd`). Unlike `node:path.resolve`, we do not
 * reach into `process.cwd()` — callers pass it explicitly when needed.
 */
export function resolve(...parts: ReadonlyArray<string>): string {
  let resolved = '';
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const piece = parts[i];
    if (piece === undefined || piece.length === 0) {
      continue;
    }
    resolved = resolved.length === 0 ? piece : `${piece}/${resolved}`;
    if (piece.startsWith('/')) {
      break;
    }
  }
  if (!resolved.startsWith('/')) {
    resolved = `/${resolved}`;
  }
  const segments: string[] = [];
  for (const segment of splitSegments(resolved)) {
    if (segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/** Narrow shape returned by {@link parse}, matching `node:path.ParsedPath`. */
export interface ParsedPath {
  readonly dir: string;
  readonly root: string;
  readonly base: string;
  readonly name: string;
  readonly ext: string;
}

/**
 * POSIX `parse` — split a path into `{ dir, root, base, name, ext }`.
 * Mirrors `node:path.parse` for the subset callers use.
 */
export function parse(p: string): ParsedPath {
  const root = p.startsWith('/') ? '/' : '';
  const base = basename(p);
  const dir = dirname(p);
  const dotIdx = base.lastIndexOf('.');
  const hasExt = dotIdx > 0;
  const ext = hasExt ? base.slice(dotIdx) : '';
  const name = hasExt ? base.slice(0, dotIdx) : base;
  return {
    dir: dir === '.' && !p.includes('/') ? '' : dir,
    root,
    base,
    name,
    ext,
  };
}

/**
 * POSIX `format` — the inverse of {@link parse}. Accepts either
 * `{ dir, base }` or `{ dir, name, ext }`. Does not accept `root` as a
 * separate input; `dir` is the source of truth.
 */
export function format(input: {
  readonly dir?: string;
  readonly base?: string;
  readonly name?: string;
  readonly ext?: string;
}): string {
  const dir = input.dir ?? '';
  const ext = input.ext ?? '';
  const base = input.base !== undefined ? input.base : `${input.name ?? ''}${ext}`;
  if (dir.length === 0) {
    return base;
  }
  if (dir === '/') {
    return `/${base}`;
  }
  return `${dir}/${base}`;
}

//#endregion
