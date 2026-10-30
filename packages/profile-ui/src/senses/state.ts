/**
 * The `state` sense: application state. Summary `store.path` (`cart.items`),
 * the value carried separately; matcher a path, optionally `= value` with a
 * JSON value (`cart.total = 42`, `user.role = "admin"`).
 */

import type { SenseGrammar, SenseMatcher, SenseMatcherParse, SenseObservation } from './types';

import { malformed, parsed } from './types';

//#region Helpers

const STATE_PATH_RE = /^[A-Za-z0-9_$-]+(\.[A-Za-z0-9_$-]+)*$/;

function isRecord<T>(value: T): value is T & Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameArray<T>(left: ReadonlyArray<T>, right: ReadonlyArray<T>): boolean {
  return left.length === right.length && left.every((item, i) => sameValue(item, right[i]));
}

function sameRecord(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) {
    return false;
  }
  return keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

function sameValue<L, R>(left: L, right: R): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return sameArray(left, right);
  }
  if (isRecord(left) && isRecord(right)) {
    return sameRecord(left, right);
  }
  return false;
}

function readValue(text: string): {
  readonly value?: unknown;
  readonly error?: string;
} {
  try {
    return {
      value: JSON.parse(text),
    };
  } catch {
    return {
      error: `'${text}' is not a JSON value; quote strings: "admin".`,
    };
  }
}

function buildMatcher(
  text: string,
  path: string,
  value?: {
    readonly equals: unknown;
  },
): SenseMatcher {
  return {
    sense: 'state',
    source: text,
    summary: path,
    equals: value?.equals,
    matches(observation: SenseObservation): boolean {
      if (observation.summary !== path) {
        return false;
      }
      return value === undefined || sameValue(observation.value, value.equals);
    },
  };
}

//#endregion

//#region Public API

/** @public Whether `path` is a well-formed state path (`cart.items`, `orders.0.id`). */
export function isStatePath(path: string): boolean {
  return STATE_PATH_RE.test(path);
}

/** @public Writes a `state` summary: the path. The value travels separately. */
export function formatStateSummary(path: string): string {
  return path.trim();
}

/** @public Parses a `state` matcher. */
export function parseStateMatcher(text: string): SenseMatcherParse {
  const eq = text.indexOf('=');
  const path = (eq === -1 ? text : text.slice(0, eq)).trim();
  if (!isStatePath(path)) {
    return malformed(`'${path}' is not a state path; write dotted names, e.g. cart.total.`);
  }
  if (eq === -1) {
    return parsed(buildMatcher(text, path));
  }
  const raw = text.slice(eq + 1).trim();
  if (raw === '') {
    return malformed(`'${text}' has '=' but no value.`);
  }
  const read = readValue(raw);
  if (read.error !== undefined) {
    return malformed(read.error);
  }
  return parsed(
    buildMatcher(text, path, {
      equals: read.value,
    }),
  );
}

/** @public The `state` sense grammar. */
export const stateSense: SenseGrammar<'state'> = {
  sense: 'state',
  summaryFormat: 'store.path',
  parse: parseStateMatcher,
};

//#endregion
