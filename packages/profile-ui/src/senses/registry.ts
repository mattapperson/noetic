/**
 * The shared sense grammars and the entry point verification uses to parse a
 * matcher for any sense: named senses by their grammar, `x-` senses by the
 * grammar their profile documents or, without one, as an exact summary.
 */

import type { SenseId } from '@noetic-tools/types';
import { isSenseId } from '@noetic-tools/types';
import { logSense } from './log';
import { netSense } from './net';
import { routeSense } from './route';
import { signalSense } from './signal';
import { stateSense } from './state';
import { storageSense } from './storage';
import { timeSense } from './time';
import type { SenseGrammar, SenseMatcher, SenseMatcherParse } from './types';
import { malformed, parsed } from './types';
import { uiSense } from './ui';

//#region Public API

/** @public The summary format of the `visual` sense: every capture is `capture`. */
export const VISUAL_SUMMARY = 'capture';

/**
 * @public
 * The grammars of every named sense that has a matcher. `visual` has none
 * (spec 36 § Senses): a matcher on it is malformed.
 */
export const senseGrammars: Readonly<
  Record<Exclude<SenseId, 'visual' | `x-${string}`>, SenseGrammar>
> = {
  ui: uiSense,
  net: netSense,
  log: logSense,
  route: routeSense,
  state: stateSense,
  signal: signalSense,
  storage: storageSense,
  time: timeSense,
};

/**
 * @public
 * The grammar for an `x-` sense whose profile documents none: the matcher text
 * is the exact summary (`{ "x-orders-db": "orders.count" }`).
 */
export function exactSummaryGrammar<S extends SenseId>(sense: S): SenseGrammar<S> {
  return {
    sense,
    summaryFormat: 'summary',
    parse(text: string): SenseMatcherParse {
      const summary = text.trim();
      if (summary === '') {
        return malformed(`A ${sense} matcher needs a summary.`);
      }
      const matcher: SenseMatcher = {
        sense,
        source: text,
        summary,
        matches: (observation): boolean => observation.summary === summary,
      };
      return parsed(matcher);
    },
  };
}

function hasGrammar(sense: string): sense is keyof typeof senseGrammars {
  return Object.hasOwn(senseGrammars, sense);
}

/** @public The grammar for `sense`, consulting `extra` (profile-documented `x-` grammars) first. */
export function senseGrammarFor(
  sense: string,
  extra: Readonly<Record<string, SenseGrammar>> = {},
): SenseGrammar | undefined {
  if (!isSenseId(sense) || sense === 'visual') {
    return undefined;
  }
  const own = extra[sense];
  if (own) {
    return own;
  }
  if (sense.startsWith('x-')) {
    return exactSummaryGrammar(sense);
  }
  return hasGrammar(sense) ? senseGrammars[sense] : undefined;
}

/**
 * @public
 * Parses `text` in `sense`'s grammar. `extra` adds grammars profiles document
 * for their `x-` senses (`appSenseGrammars`, `browserSenseGrammars`).
 * Never throws: a malformed matcher, an unknown sense and `visual` all come
 * back as `{ ok: false, reason }`.
 */
export function parseSenseMatcher(
  sense: string,
  text: string,
  extra: Readonly<Record<string, SenseGrammar>> = {},
): SenseMatcherParse {
  if (sense === 'visual') {
    return malformed('The visual sense has no matcher.');
  }
  const grammar = senseGrammarFor(sense, extra);
  if (!grammar) {
    return malformed(`'${sense}' is not a sense; use a named sense or an 'x-' sense.`);
  }
  return grammar.parse(text);
}

//#endregion
