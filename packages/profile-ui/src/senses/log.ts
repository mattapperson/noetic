/**
 * The `log` sense: errors and messages. Summary `level message`
 * (`error Uncaught TypeError: x is undefined`); matcher a level, optionally
 * with a quoted substring of the message (`error`, `error "TypeError"`).
 */

import { tokenize } from './lexer';
import type { SenseGrammar, SenseMatcher, SenseMatcherParse } from './types';
import { malformed, parsed } from './types';

//#region Types

/** @public What a `log` summary is written from, and what it reads back as. */
export interface LogSummaryParts {
  /** A lowercase level: `error`, `warn`, `info`, `debug`, … */
  readonly level: string;
  readonly message: string;
}

//#endregion

//#region Helpers

const LEVEL_RE = /^[a-z]+$/;

//#endregion

//#region Public API

/** @public Writes a `log` summary: `level message`, the message on one line. */
export function formatLogSummary(parts: LogSummaryParts): string {
  const message = parts.message.replace(/\s+/g, ' ').trim();
  const level = parts.level.toLowerCase();
  return message === '' ? level : `${level} ${message}`;
}

/** @public Reads a `log` summary back, or `undefined` when it is not one. */
export function parseLogSummary(summary: string): LogSummaryParts | undefined {
  const space = summary.indexOf(' ');
  const level = space === -1 ? summary : summary.slice(0, space);
  if (!LEVEL_RE.test(level)) {
    return undefined;
  }
  return {
    level,
    message: space === -1 ? '' : summary.slice(space + 1),
  };
}

/** @public Parses a `log` matcher. */
export function parseLogMatcher(text: string): SenseMatcherParse {
  const read = tokenize(text);
  if (!read.ok) {
    return malformed(read.reason);
  }
  const [level, substring, extra] = read.tokens;
  if (!level || level.kind !== 'word' || !LEVEL_RE.test(level.value)) {
    return malformed('A log matcher starts with a lowercase level, e.g. error "TypeError".');
  }
  if (extra || (substring && substring.kind !== 'quoted')) {
    return malformed('A log matcher is a level and at most one quoted substring.');
  }
  const contains = substring?.value;
  const matcher: SenseMatcher = {
    sense: 'log',
    source: text,
    matches(observation): boolean {
      const entry = parseLogSummary(observation.summary);
      if (!entry || entry.level !== level.value) {
        return false;
      }
      return contains === undefined || entry.message.includes(contains);
    },
  };
  return parsed(matcher);
}

/** @public The `log` sense grammar. */
export const logSense: SenseGrammar<'log'> = {
  sense: 'log',
  summaryFormat: 'level message',
  parse: parseLogMatcher,
};

//#endregion
