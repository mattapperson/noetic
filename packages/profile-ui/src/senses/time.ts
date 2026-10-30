/**
 * The `time` sense: what settled and what is in flight. Summary `settled` or
 * `in-flight NAME`; matcher a word, `settled` or `in-flight`.
 */

import type { SenseGrammar, SenseMatcher, SenseMatcherParse } from './types';

import { malformed, parsed } from './types';

//#region Types

/** @public What a `time` summary is written from. */
export type TimeSummaryParts =
  | {
      readonly state: 'settled';
    }
  | {
      readonly state: 'in-flight';
      readonly name: string;
    };

/** @public The words a `time` matcher may be. */
export const TimeWord = {
  Settled: 'settled',
  InFlight: 'in-flight',
} as const;

/** @public One of `TimeWord`. */
export type TimeWord = (typeof TimeWord)[keyof typeof TimeWord];

//#endregion

//#region Helpers

function isTimeWord(word: string): word is TimeWord {
  return word === TimeWord.Settled || word === TimeWord.InFlight;
}

function firstWord(summary: string): string {
  const space = summary.indexOf(' ');
  return space === -1 ? summary : summary.slice(0, space);
}

//#endregion

//#region Public API

/** @public Writes a `time` summary: `settled` or `in-flight NAME`. */
export function formatTimeSummary(parts: TimeSummaryParts): string {
  if (parts.state === 'settled') {
    return 'settled';
  }
  return `in-flight ${parts.name.replace(/\s+/g, '-')}`;
}

/** @public Parses a `time` matcher. */
export function parseTimeMatcher(text: string): SenseMatcherParse {
  const word = text.trim();
  if (!isTimeWord(word)) {
    return malformed(`'${text}' is not a time word; use 'settled' or 'in-flight'.`);
  }
  const matcher: SenseMatcher = {
    sense: 'time',
    source: text,
    summary: word === TimeWord.Settled ? word : undefined,
    matches: (observation): boolean => firstWord(observation.summary) === word,
  };
  return parsed(matcher);
}

/** @public The `time` sense grammar. */
export const timeSense: SenseGrammar<'time'> = {
  sense: 'time',
  summaryFormat: 'settled | in-flight NAME',
  parse: parseTimeMatcher,
};

//#endregion
