/**
 * The `route` sense: where the user is. Summary the path
 * (`/checkout/done`); matcher a path, `*` and `**` globs allowed.
 */

import { hasGlob, matchesGlob } from './glob';
import type { SenseGrammar, SenseMatcher, SenseMatcherParse } from './types';
import { malformed, parsed } from './types';

//#region Helpers

const ROUTE_RE = /^\/[^\s?#"]*$/;
const RELATIVE_BASE = 'http://relative.invalid';

//#endregion

//#region Public API

/** @public Writes a `route` summary: the path of a URL or path, without query or fragment. */
export function formatRouteSummary(urlOrPath: string): string {
  return new URL(urlOrPath, RELATIVE_BASE).pathname;
}

/** @public Parses a `route` matcher. */
export function parseRouteMatcher(text: string): SenseMatcherParse {
  const pattern = text.trim();
  if (!ROUTE_RE.test(pattern)) {
    return malformed(
      `'${text}' is not a route; write a path starting with '/', without query or fragment.`,
    );
  }
  const matcher: SenseMatcher = {
    sense: 'route',
    source: text,
    summary: hasGlob(pattern) ? undefined : pattern,
    matches: (observation): boolean => matchesGlob(pattern, observation.summary),
  };
  return parsed(matcher);
}

/** @public The `route` sense grammar. */
export const routeSense: SenseGrammar<'route'> = {
  sense: 'route',
  summaryFormat: '/path',
  parse: parseRouteMatcher,
};

//#endregion
