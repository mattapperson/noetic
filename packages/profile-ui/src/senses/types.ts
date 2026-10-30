/**
 * The shapes every sense grammar shares (spec 36 § Senses): an observation a
 * server reports, a parsed matcher, and the grammar that parses one.
 */

import type { SenseId } from '@noetic-tools/types';

//#region Types

/** @public One observation on a sense: its summary in the § Senses format, and the value it carries, if any. */
export interface SenseObservation<V = unknown> {
  readonly summary: string;
  readonly value?: V;
}

/** @public A matcher parsed from one sense's grammar. */
export interface SenseMatcher {
  readonly sense: SenseId;
  /** The matcher text as written. */
  readonly source: string;
  /**
   * The exact summary this matcher lowers to (OVP `match.summary`), present
   * only when the matcher has no wildcard, status class or partial part.
   * Absent, the matcher is evaluated by Noetic as an implementation predicate.
   */
  readonly summary?: string;
  /** A value the observation must also carry (`state` matchers written `path = value`). */
  readonly equals?: unknown;
  /** Whether an observation matches. */
  matches(observation: SenseObservation): boolean;
}

/** @public The result of parsing a matcher: the matcher, or why its text is malformed. */
export type SenseMatcherParse =
  | {
      readonly ok: true;
      readonly matcher: SenseMatcher;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

/** @public One sense's matcher grammar. */
export interface SenseGrammar<S extends SenseId = SenseId> {
  readonly sense: S;
  /** The summary format, as spec 36 § Senses writes it. */
  readonly summaryFormat: string;
  /** Parses matcher text; never throws. */
  parse(text: string): SenseMatcherParse;
}

//#endregion

//#region Helpers

/** @public A failed parse. */
export function malformed(reason: string): SenseMatcherParse {
  return {
    ok: false,
    reason,
  };
}

/** @public A successful parse. */
export function parsed(matcher: SenseMatcher): SenseMatcherParse {
  return {
    ok: true,
    matcher,
  };
}

//#endregion
