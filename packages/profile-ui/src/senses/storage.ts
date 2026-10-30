/**
 * The `storage` sense: values that outlive a screen. Summary `kind key`
 * (`local session`), the key quoted when it is not one plain word; matcher a
 * kind and a key.
 */

import { quoteIfNeeded, tokenize } from './lexer';
import type { SenseGrammar, SenseMatcher, SenseMatcherParse } from './types';
import { malformed, parsed } from './types';

//#region Types

/** @public A stored value's place: `local`, `session`, `cookie`, `indexeddb`, … and its key. */
export interface StorageSummaryParts {
  readonly kind: string;
  readonly key: string;
}

//#endregion

//#region Helpers

const KIND_RE = /^[a-z][a-z0-9-]*$/;

//#endregion

//#region Public API

/** @public Writes a `storage` summary: `kind key`. */
export function formatStorageSummary(parts: StorageSummaryParts): string {
  return `${parts.kind} ${quoteIfNeeded(parts.key)}`;
}

/** @public Reads a `storage` summary or matcher back, or why it is malformed. */
export function parseStorageSummary(text: string): StorageSummaryParts | string {
  const read = tokenize(text);
  if (!read.ok) {
    return read.reason;
  }
  const [kind, key, extra] = read.tokens;
  if (!kind || kind.kind !== 'word' || !KIND_RE.test(kind.value)) {
    return 'A storage matcher starts with a lowercase kind, e.g. local session.';
  }
  if (!key || extra) {
    return 'A storage matcher is a kind and one key; quote a key with spaces.';
  }
  return {
    kind: kind.value,
    key: key.value,
  };
}

/** @public Parses a `storage` matcher. */
export function parseStorageMatcher(text: string): SenseMatcherParse {
  const place = parseStorageSummary(text);
  if (typeof place === 'string') {
    return malformed(place);
  }
  const summary = formatStorageSummary(place);
  const matcher: SenseMatcher = {
    sense: 'storage',
    source: text,
    summary,
    matches(observation): boolean {
      const seen = parseStorageSummary(observation.summary);
      return typeof seen !== 'string' && seen.kind === place.kind && seen.key === place.key;
    },
  };
  return parsed(matcher);
}

/** @public The `storage` sense grammar. */
export const storageSense: SenseGrammar<'storage'> = {
  sense: 'storage',
  summaryFormat: 'kind key',
  parse: parseStorageMatcher,
};

//#endregion
