/**
 * The `signal` sense: events the application announces. Summary the signal
 * name (`order.placed`); matcher a name.
 */

import type { SenseGrammar, SenseMatcher, SenseMatcherParse } from './types';

import { malformed, parsed } from './types';

//#region Helpers

const SIGNAL_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]*$/;

//#endregion

//#region Public API

/** @public Whether `name` is a well-formed signal name. */
export function isSignalName(name: string): boolean {
  return SIGNAL_RE.test(name);
}

/** @public Writes a `signal` summary: the name. */
export function formatSignalSummary(name: string): string {
  return name.trim();
}

/** @public Parses a `signal` matcher. */
export function parseSignalMatcher(text: string): SenseMatcherParse {
  const name = text.trim();
  if (!isSignalName(name)) {
    return malformed(`'${text}' is not a signal name, e.g. order.placed.`);
  }
  const matcher: SenseMatcher = {
    sense: 'signal',
    source: text,
    summary: name,
    matches: (observation): boolean => observation.summary === name,
  };
  return parsed(matcher);
}

/** @public The `signal` sense grammar. */
export const signalSense: SenseGrammar<'signal'> = {
  sense: 'signal',
  summaryFormat: 'name',
  parse: parseSignalMatcher,
};

//#endregion
