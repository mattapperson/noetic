/**
 * Path globs for the `route` and `net` matchers: `*` matches within one path
 * segment, `**` across segments, and a trailing `/**` also matches the bare
 * prefix (`/checkout/**` matches `/checkout`).
 */

//#region Helpers

const SPECIAL_RE = /[.+?^${}()|[\]\\]/;

function escapeChar(char: string): string {
  return SPECIAL_RE.test(char) ? `\\${char}` : char;
}

//#endregion

//#region Public API

/** @public Whether a pattern has a wildcard. */
export function hasGlob(pattern: string): boolean {
  return pattern.includes('*');
}

/** @public Compiles a path glob to an anchored regular expression. */
export function globToRegExp(pattern: string): RegExp {
  let source = '^';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('/**', i) && i + 3 === pattern.length) {
      source += '(?:/.*)?';
      i += 3;
      continue;
    }
    if (pattern.startsWith('**', i)) {
      source += '.*';
      i += 2;
      continue;
    }
    const char = pattern[i] ?? '';
    source += char === '*' ? '[^/]*' : escapeChar(char);
    i++;
  }
  return new RegExp(`${source}$`);
}

/** @public Whether `path` matches the glob `pattern`. */
export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

//#endregion
