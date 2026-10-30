/**
 * The `net` sense: requests and responses. Summary `METHOD /path STATUS`
 * (`POST /api/orders 201`): the query is omitted and a cross-origin request
 * keeps its full origin. A matcher gives any of method, path and status, in
 * that order: `POST /api/orders 201`, `GET /api/*`, `5xx`.
 */

import { hasGlob, matchesGlob } from './glob';
import { tokenize } from './lexer';
import type { SenseGrammar, SenseMatcher, SenseMatcherParse, SenseObservation } from './types';
import { malformed, parsed } from './types';

//#region Types

/** @public What a `net` summary is written from. */
export interface NetSummaryInput {
  readonly method: string;
  /** The request URL, absolute or relative to `origin`. */
  readonly url: string;
  /** The response status; omitted while there is none. */
  readonly status?: number | null;
  /** The page's origin. Requests to it are written as a path, others keep their origin. */
  readonly origin?: string;
}

/** @public A `net` summary read back. */
export interface NetSummaryParts {
  readonly method: string;
  readonly target: string;
  readonly status?: number;
}

interface NetPattern {
  method?: string;
  target?: string;
  status?: string;
}

type NetPart = keyof NetPattern;

//#endregion

//#region Helpers

const METHOD_RE = /^[A-Z]+$/;
const STATUS_RE = /^[1-5]\d\d$/;
const STATUS_CLASS_RE = /^[1-5][xX]{2}$/;
const ABSOLUTE_RE = /^https?:\/\//;
const RELATIVE_BASE = 'http://relative.invalid';
const PART_ORDER: ReadonlyArray<NetPart> = [
  'method',
  'target',
  'status',
];

function classify(word: string): NetPart | undefined {
  if (METHOD_RE.test(word)) {
    return 'method';
  }
  if (word.startsWith('/') || ABSOLUTE_RE.test(word)) {
    return 'target';
  }
  if (STATUS_RE.test(word) || STATUS_CLASS_RE.test(word)) {
    return 'status';
  }
  return undefined;
}

function checkTarget(target: string): string | undefined {
  if (/[?#]/.test(target)) {
    return `'${target}' has a query or fragment; net summaries omit them.`;
  }
  return undefined;
}

function readPattern(text: string): NetPattern | string {
  const read = tokenize(text);
  if (!read.ok) {
    return read.reason;
  }
  if (read.tokens.length === 0) {
    return 'A net matcher needs a method, a path or a status, e.g. POST /api/orders 201.';
  }
  const pattern: NetPattern = {};
  let last = -1;
  for (const token of read.tokens) {
    const part = token.kind === 'word' ? classify(token.value) : undefined;
    if (!part) {
      return `'${token.value}' is not a method, a path or a status.`;
    }
    const index = PART_ORDER.indexOf(part);
    if (index <= last) {
      return 'A net matcher gives method, path and status at most once each, in that order.';
    }
    last = index;
    pattern[part] = token.value;
  }
  return pattern.target ? (checkTarget(pattern.target) ?? pattern) : pattern;
}

function statusMatches(pattern: string, status: number | undefined): boolean {
  if (status === undefined) {
    return false;
  }
  if (STATUS_CLASS_RE.test(pattern)) {
    return String(status)[0] === pattern[0];
  }
  return Number(pattern) === status;
}

function patternMatches(pattern: NetPattern, observation: SenseObservation): boolean {
  const request = parseNetSummary(observation.summary);
  if (!request) {
    return false;
  }
  if (pattern.method !== undefined && pattern.method !== request.method) {
    return false;
  }
  if (pattern.target !== undefined && !matchesGlob(pattern.target, request.target)) {
    return false;
  }
  return pattern.status === undefined || statusMatches(pattern.status, request.status);
}

function exactSummary(pattern: NetPattern): string | undefined {
  const { method, target, status } = pattern;
  if (!method || !target || !status || hasGlob(target) || !STATUS_RE.test(status)) {
    return undefined;
  }
  return `${method} ${target} ${status}`;
}

//#endregion

//#region Public API

/** @public Writes a `net` summary: `METHOD /path STATUS`, the query omitted, the origin kept when cross-origin. */
export function formatNetSummary(input: NetSummaryInput): string {
  const absolute = ABSOLUTE_RE.test(input.url);
  const url = new URL(input.url, input.origin ?? RELATIVE_BASE);
  const sameOrigin = !absolute || (input.origin !== undefined && url.origin === input.origin);
  const target = sameOrigin ? url.pathname : `${url.origin}${url.pathname}`;
  const head = `${input.method.toUpperCase()} ${target}`;
  return input.status === undefined || input.status === null ? head : `${head} ${input.status}`;
}

/** @public Reads a `net` summary back, or `undefined` when it is not one. */
export function parseNetSummary(summary: string): NetSummaryParts | undefined {
  const [method, target, status, extra] = summary.split(' ');
  if (!method || !target || extra !== undefined || !METHOD_RE.test(method)) {
    return undefined;
  }
  if (status !== undefined && !STATUS_RE.test(status)) {
    return undefined;
  }
  return {
    method,
    target,
    status: status === undefined ? undefined : Number(status),
  };
}

/** @public Parses a `net` matcher. */
export function parseNetMatcher(text: string): SenseMatcherParse {
  const pattern = readPattern(text);
  if (typeof pattern === 'string') {
    return malformed(pattern);
  }
  const matcher: SenseMatcher = {
    sense: 'net',
    source: text,
    summary: exactSummary(pattern),
    matches: (observation): boolean => patternMatches(pattern, observation),
  };
  return parsed(matcher);
}

/** @public The `net` sense grammar. */
export const netSense: SenseGrammar<'net'> = {
  sense: 'net',
  summaryFormat: 'METHOD /path STATUS',
  parse: parseNetMatcher,
};

//#endregion
