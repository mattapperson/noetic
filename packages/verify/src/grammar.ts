/**
 * The matcher grammar of each sense (spec 36 § Senses). A matcher compiles to a
 * selection: a test over an observation's summary (and, for `state = value`,
 * its value), plus the exact summary when the matcher has no wildcard so it can
 * lower to OVP's own `summary` match.
 */

import type { Observation } from '@noetic-tools/types/verify';
import { render } from 'open-verification';
import { z } from 'zod';
import { verifyInvalid } from './errors';

//#region Types

/** A compiled matcher. */
export interface Selection {
  /** The summary an observation must equal, when the matcher has no wildcard. */
  readonly exact?: string;
  /** Whether the matcher also constrains the observation's value (`state` with `= value`). */
  readonly checksValue: boolean;
  /** Whether an observation falls inside the selection. */
  test(observation: Observation): boolean;
}

type SenseGrammar = (text: string) => Selection | undefined;

//#endregion

//#region Constants

const NET_METHOD_RE = /^[A-Z]+$/;
const NET_STATUS_RE = /^[1-5](?:\d\d|xx)$/;
const UI_RE = /^([a-z][a-z0-9-]*)(?:\s+"((?:[^"\\]|\\.)*)")?$/;
const LOG_RE = /^([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)")?$/;
const STATE_RE = /^([A-Za-z_$][\w$-]*(?:\.[\w$-]+|\[\d+\])*)(?:\s*=\s*(.+))?$/;
const SIGNAL_RE = /^[A-Za-z0-9_.:*-]+$/;
const STORAGE_RE = /^(\S+)\s+(\S+)$/;
const TIME_RE = /^(settled|in-flight)(?:\s+(\S+))?$/;

const JsonScalarSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

//#endregion

//#region Helpers

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** A glob as a regular expression. With `segments`, `*` stops at `/` and `**` crosses it. */
export function globToRegExp(glob: string, segments: boolean): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob.charAt(i);
    if (ch !== '*') {
      out += escapeRegExp(ch);
      continue;
    }
    if (glob.charAt(i + 1) === '*') {
      out += '.*';
      i++;
      continue;
    }
    out += segments ? '[^/]*' : '.*';
  }
  return new RegExp(`^${out}$`);
}

function unescapeQuoted(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

function summaryEquals(exact: string): Selection {
  return {
    exact,
    checksValue: false,
    test: (o) => o.summary === exact,
  };
}

function summaryMatches(test: (summary: string) => boolean): Selection {
  return {
    checksValue: false,
    test: (o) => test(o.summary),
  };
}

/** A `*` glob over the whole summary, or an exact match when there is no `*`. */
function globOrExact(text: string, segments: boolean): Selection {
  if (!text.includes('*')) {
    return summaryEquals(text);
  }
  const re = globToRegExp(text, segments);
  return summaryMatches((s) => re.test(s));
}

/** A JSON scalar literal (`42`, `true`, `"a b"`, `null`) when the text is one, otherwise the text itself. */
function parseLiteral(text: string): string | number | boolean | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const scalar = JsonScalarSchema.safeParse(parsed);
  return scalar.success ? scalar.data : text;
}

//#endregion

//#region Sense grammars

interface NetParts {
  method?: string;
  path?: string;
  status?: string;
}

/** Splits a net matcher into method, path and status, in that order, each at most once. */
function netParts(text: string): NetParts | undefined {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0 || tokens.length > 3) {
    return undefined;
  }
  const parts: NetParts = {};
  let stage = 0;
  for (const token of tokens) {
    const next = netStage(token);
    if (next === undefined || next < stage) {
      return undefined;
    }
    const key = next === 0 ? 'method' : next === 1 ? 'path' : 'status';
    if (parts[key] !== undefined) {
      return undefined;
    }
    parts[key] = token;
    stage = next + 1;
  }
  return parts;
}

function netStage(token: string): number | undefined {
  if (NET_METHOD_RE.test(token)) {
    return 0;
  }
  if (token.startsWith('/') || /^https?:\/\//.test(token) || token === '*') {
    return 1;
  }
  if (NET_STATUS_RE.test(token)) {
    return 2;
  }
  return undefined;
}

function statusMatches(pattern: string, status: string | undefined): boolean {
  if (status === undefined) {
    return false;
  }
  if (!pattern.endsWith('xx')) {
    return pattern === status;
  }
  return status.length === 3 && status.charAt(0) === pattern.charAt(0);
}

function netGrammar(text: string): Selection | undefined {
  const parts = netParts(text);
  if (!parts) {
    return undefined;
  }
  const { method, path, status } = parts;
  const wild = path?.includes('*') === true || status?.endsWith('xx') === true;
  if (method && path && status && !wild) {
    return summaryEquals(`${method} ${path} ${status}`);
  }
  const pathRe = path === undefined ? undefined : globToRegExp(path, true);
  return summaryMatches((summary) => {
    const [m, p, s] = summary.split(/\s+/);
    if (method !== undefined && m !== method) {
      return false;
    }
    if (pathRe !== undefined && (p === undefined || !pathRe.test(p))) {
      return false;
    }
    return status === undefined || statusMatches(status, s);
  });
}

function uiGrammar(text: string): Selection | undefined {
  const m = UI_RE.exec(text);
  if (!m) {
    return undefined;
  }
  const role = m[1] ?? '';
  const name = m[2];
  if (name !== undefined) {
    return summaryEquals(`${role} "${name}"`);
  }
  return summaryMatches((s) => s === role || s.startsWith(`${role} `));
}

function logGrammar(text: string): Selection | undefined {
  const m = LOG_RE.exec(text);
  if (!m) {
    return undefined;
  }
  const level = m[1] ?? '';
  const quoted = m[2];
  const needle = quoted === undefined ? undefined : unescapeQuoted(quoted);
  return summaryMatches((s) => {
    if (s !== level && !s.startsWith(`${level} `)) {
      return false;
    }
    return needle === undefined || s.slice(level.length + 1).includes(needle);
  });
}

function routeGrammar(text: string): Selection | undefined {
  if (!text.startsWith('/') && !/^https?:\/\//.test(text)) {
    return undefined;
  }
  if (/\s/.test(text)) {
    return undefined;
  }
  return globOrExact(text, true);
}

function stateGrammar(text: string): Selection | undefined {
  const m = STATE_RE.exec(text);
  if (!m) {
    return undefined;
  }
  const path = m[1] ?? '';
  const rawValue = m[2];
  if (rawValue === undefined) {
    return summaryEquals(path);
  }
  const expected = parseLiteral(rawValue.trim());
  return {
    checksValue: true,
    test: (o) => o.summary === path && valuesEqual(o.value, expected),
  };
}

function signalGrammar(text: string): Selection | undefined {
  if (!SIGNAL_RE.test(text)) {
    return undefined;
  }
  return globOrExact(text, false);
}

function storageGrammar(text: string): Selection | undefined {
  const m = STORAGE_RE.exec(text);
  if (!m) {
    return undefined;
  }
  return globOrExact(`${m[1]} ${m[2]}`, false);
}

function timeGrammar(text: string): Selection | undefined {
  const m = TIME_RE.exec(text);
  if (!m) {
    return undefined;
  }
  if (m[1] === 'settled' && m[2] !== undefined) {
    return undefined;
  }
  if (m[1] === 'in-flight' && m[2] === undefined) {
    return summaryMatches((s) => s.startsWith('in-flight '));
  }
  return summaryEquals(text);
}

function visualGrammar(text: string): Selection | undefined {
  return text === 'capture' ? summaryEquals(text) : undefined;
}

/** `x-` senses are documented by their profile: exact text, or a `*` glob. */
function extensionGrammar(text: string): Selection | undefined {
  return globOrExact(text, false);
}

const SENSE_GRAMMARS: Readonly<Record<string, SenseGrammar>> = {
  net: netGrammar,
  ui: uiGrammar,
  log: logGrammar,
  route: routeGrammar,
  state: stateGrammar,
  signal: signalGrammar,
  storage: storageGrammar,
  time: timeGrammar,
  visual: visualGrammar,
};

//#endregion

//#region Public API

/** Whether two observed values are the same: numbers within `tolerance`, anything else by rendering. */
export function valuesEqual(actual: unknown, expected: unknown, tolerance = 0): boolean {
  if (typeof actual === 'number' && typeof expected === 'number') {
    return Math.abs(actual - expected) <= tolerance;
  }
  return render(actual) === render(expected);
}

/**
 * Compiles a matcher in its sense's grammar.
 * @returns The selection, or `undefined` when the grammar cannot parse it.
 */
export function tryCompileMatcher(sense: string, text: string): Selection | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const grammar = SENSE_GRAMMARS[sense] ?? (sense.startsWith('x-') ? extensionGrammar : undefined);
  return grammar?.(trimmed);
}

/**
 * Compiles a matcher in its sense's grammar.
 * @throws NoeticConfigError `VERIFY_INVALID` when the grammar cannot parse it.
 */
export function compileMatcher(sense: string, text: string): Selection {
  const selection = tryCompileMatcher(sense, text);
  if (!selection) {
    throw verifyInvalid(
      `Matcher '${text}' cannot be parsed in the grammar of sense '${sense}'.`,
      `Write ${sense} matchers as spec 36 § Senses describes, e.g. ${exampleFor(sense)}.`,
    );
  }
  return selection;
}

function exampleFor(sense: string): string {
  const examples: Readonly<Record<string, string>> = {
    net: "'POST /api/orders 201', 'GET /api/*' or '5xx'",
    ui: "'button \"Pay\"' or 'heading'",
    log: "'error' or 'error \"TypeError\"'",
    route: "'/checkout/done' or '/checkout/**'",
    state: "'cart.items' or 'cart.total = 42'",
    signal: "'order.placed'",
    storage: "'local session'",
    time: "'settled' or 'in-flight upload'",
    visual: "'capture'",
  };
  return examples[sense] ?? "the profile's documented text";
}

//#endregion
