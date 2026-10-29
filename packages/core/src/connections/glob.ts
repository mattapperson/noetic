/**
 * Glob matching over dotted operation and event names (spec 35 § Gates,
 * § What a document may use). `*` matches any run of characters, including
 * dots, so `'ui.*'` covers `ui.tap` and `com.slack.admin.*` covers every admin
 * operation; `?` matches one character. Everything else is literal.
 */

//#region Helpers

const cache = new Map<string, RegExp>();

function escapeLiteral(char: string): string {
  return /[\\^$.|+()[\]{}]/.test(char) ? `\\${char}` : char;
}

function compile(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached) {
    return cached;
  }
  let source = '';
  for (const char of pattern) {
    if (char === '*') {
      source += '.*';
      continue;
    }
    if (char === '?') {
      source += '.';
      continue;
    }
    source += escapeLiteral(char);
  }
  const compiled = new RegExp(`^${source}$`);
  cache.set(pattern, compiled);
  return compiled;
}

//#endregion

//#region Public API

/** Whether `name` matches the glob `pattern`. */
export function matchesGlob(pattern: string, name: string): boolean {
  return compile(pattern).test(name);
}

/** Whether `name` matches any of `patterns`. An absent or empty list matches nothing. */
export function matchesAnyGlob(patterns: ReadonlyArray<string> | undefined, name: string): boolean {
  if (!patterns) {
    return false;
  }
  return patterns.some((pattern) => matchesGlob(pattern, name));
}

//#endregion
