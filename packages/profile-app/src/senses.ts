/**
 * The `x-` senses `app@1` documents. They are separate senses because one is
 * the app describing itself and the other is not (OVP-CHAN-5):
 *
 * - `x-exit` — the app's own exit code. Summary `exit CODE` (`exit 0`);
 *   matcher `exit`, `exit CODE` or `exit nonzero`.
 * - `x-termination` — ended by the operating system or a supervisor. Summary
 *   `terminated REASON` (`terminated SIGKILL`); matcher `terminated`,
 *   optionally with a reason.
 */

import type { SenseGrammar, SenseMatcher, SenseMatcherParse } from '@noetic-tools/profile-ui';
import { malformed, parsed } from '@noetic-tools/profile-ui';
import type { SenseDescriptor } from '@noetic-tools/types';

//#region Helpers

const CODE_RE = /^-?\d+$/;
const REASON_RE = /^[A-Za-z0-9_.-]+$/;
const NONZERO = 'nonzero';

function words(text: string): ReadonlyArray<string> {
  const trimmed = text.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}

function readExit(text: string):
  | {
      readonly code?: string;
    }
  | string {
  const [word, code, extra] = words(text);
  if (word !== 'exit') {
    return "An x-exit matcher starts with 'exit'.";
  }
  if (extra !== undefined) {
    return 'An x-exit matcher is exit and at most one code.';
  }
  if (code !== undefined && code !== NONZERO && !CODE_RE.test(code)) {
    return `'${code}' is not an exit code; use an integer or 'nonzero'.`;
  }
  return {
    code,
  };
}

function exitMatches(wanted: string | undefined, summary: string): boolean {
  const seen = readExit(summary);
  if (typeof seen === 'string' || seen.code === undefined || seen.code === NONZERO) {
    return false;
  }
  if (wanted === undefined) {
    return true;
  }
  if (wanted === NONZERO) {
    return Number(seen.code) !== 0;
  }
  return Number(seen.code) === Number(wanted);
}

function readTermination(text: string):
  | {
      readonly reason?: string;
    }
  | string {
  const [word, reason, extra] = words(text);
  if (word !== 'terminated') {
    return "An x-termination matcher starts with 'terminated'.";
  }
  if (extra !== undefined) {
    return 'An x-termination matcher is terminated and at most one reason.';
  }
  if (reason !== undefined && !REASON_RE.test(reason)) {
    return `'${reason}' is not a termination reason, e.g. SIGKILL.`;
  }
  return {
    reason,
  };
}

//#endregion

//#region Public API

/** @public The `x-exit` descriptor: the app reports its own exit code. */
export const EXIT_SENSE_DESCRIPTOR: SenseDescriptor = {
  independence: 'actuation-derived',
  grade: 'consequence',
  note: "The app's own exit code: the app describing itself.",
};

/** @public The `x-termination` descriptor: the operating system or a supervisor reports it. */
export const TERMINATION_SENSE_DESCRIPTOR: SenseDescriptor = {
  independence: 'independent',
  grade: 'consequence',
  note: 'Ended by the operating system or a supervisor, not the app.',
};

/** @public Writes an `x-exit` summary: `exit CODE`. */
export function formatExitSummary(code: number): string {
  return `exit ${Math.trunc(code)}`;
}

/** @public Writes an `x-termination` summary: `terminated REASON`. */
export function formatTerminationSummary(reason: string): string {
  const word = reason.trim().replace(/[^A-Za-z0-9_.-]+/g, '-');
  return `terminated ${word === '' ? 'unknown' : word}`;
}

/** @public Parses an `x-exit` matcher. */
export function parseExitMatcher(text: string): SenseMatcherParse {
  const exit = readExit(text);
  if (typeof exit === 'string') {
    return malformed(exit);
  }
  const wanted = exit.code;
  const exact = wanted !== undefined && wanted !== NONZERO;
  const matcher: SenseMatcher = {
    sense: 'x-exit',
    source: text,
    summary: exact ? formatExitSummary(Number(wanted)) : undefined,
    matches: (observation): boolean => exitMatches(wanted, observation.summary),
  };
  return parsed(matcher);
}

/** @public Parses an `x-termination` matcher. */
export function parseTerminationMatcher(text: string): SenseMatcherParse {
  const termination = readTermination(text);
  if (typeof termination === 'string') {
    return malformed(termination);
  }
  const wanted = termination.reason;
  const matcher: SenseMatcher = {
    sense: 'x-termination',
    source: text,
    summary: wanted === undefined ? undefined : `terminated ${wanted}`,
    matches(observation): boolean {
      const seen = readTermination(observation.summary);
      if (typeof seen === 'string' || seen.reason === undefined) {
        return false;
      }
      return wanted === undefined || seen.reason === wanted;
    },
  };
  return parsed(matcher);
}

/** @public The `x-exit` sense grammar. */
export const exitSense: SenseGrammar<'x-exit'> = {
  sense: 'x-exit',
  summaryFormat: 'exit CODE',
  parse: parseExitMatcher,
};

/** @public The `x-termination` sense grammar. */
export const terminationSense: SenseGrammar<'x-termination'> = {
  sense: 'x-termination',
  summaryFormat: 'terminated REASON',
  parse: parseTerminationMatcher,
};

/** @public The `x-` sense grammars `app@1` documents, for `parseSenseMatcher`'s `extra`. */
export const appSenseGrammars: Readonly<Record<string, SenseGrammar>> = {
  'x-exit': exitSense,
  'x-termination': terminationSense,
};

//#endregion
