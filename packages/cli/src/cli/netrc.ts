/**
 * Minimal `.netrc` reader used to discover credentials when the corresponding
 * environment variables are unset.
 *
 * Supported tokens: `machine <name>`, `default`, `login <user>`,
 * `password <pass>`, `account <acct>`, `macdef <name>` (block is skipped).
 * Lines starting with `#` are treated as comments — netrc(5) does not formally
 * specify comments, but most readers (incl. curl) accept them.
 *
 * Security: if the file is group- or world-readable we emit a one-line warning
 * to stderr but still load the credential — refusing would be more surprising
 * than helpful for a CLI dev tool. Callers who want hard refusal can inspect
 * the returned `permissive` flag.
 */

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface NetrcEntry {
  machine: string;
  login?: string;
  password?: string;
  account?: string;
}

export interface NetrcLookupResult {
  entry: NetrcEntry;
  /** True when the source file's permissions allow group/world read. */
  permissive: boolean;
}

const DEFAULT_PATH = join(homedir(), '.netrc');

/**
 * Tokenize a `.netrc` body: whitespace-separated tokens with `#`-prefixed
 * line comments stripped.
 */
function tokenize(body: string): string[] {
  const tokens: string[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/^\s*#.*$/, '');
    if (line.trim().length === 0) {
      continue;
    }
    for (const tok of line.split(/\s+/)) {
      if (tok.length > 0) {
        tokens.push(tok);
      }
    }
  }
  return tokens;
}

interface ParseCursor {
  i: number;
  current: NetrcEntry | null;
  entries: NetrcEntry[];
}

type CredentialToken = 'login' | 'password' | 'account';
const CREDENTIAL_TOKENS: ReadonlySet<string> = new Set<string>([
  'login',
  'password',
  'account',
]);

function isCredentialToken(tok: string): tok is CredentialToken {
  return CREDENTIAL_TOKENS.has(tok);
}

/** Start a new entry, flushing any in-progress one to `entries`. */
function pushAndStart(cursor: ParseCursor, machine: string): void {
  if (cursor.current !== null) {
    cursor.entries.push(cursor.current);
  }
  cursor.current = {
    machine,
  };
}

/** Apply `tokens[i]` to the parse cursor; returns the index increment. */
function applyToken(tokens: string[], cursor: ParseCursor): number {
  const tok = tokens[cursor.i];
  if (tok === 'machine') {
    pushAndStart(cursor, tokens[cursor.i + 1] ?? '');
    return 2;
  }
  if (tok === 'default') {
    pushAndStart(cursor, 'default');
    return 1;
  }
  if (tok === 'macdef') {
    // `macdef <name>` runs until the next blank line — but we already split
    // on whitespace, so just skip the name token. Best-effort: sufficient
    // for credential lookup.
    return 2;
  }
  if (cursor.current !== null && tok !== undefined && isCredentialToken(tok)) {
    const value = tokens[cursor.i + 1];
    if (value !== undefined) {
      cursor.current[tok] = value;
      return 2;
    }
  }
  return 1;
}

function parse(body: string): NetrcEntry[] {
  const tokens = tokenize(body);
  const cursor: ParseCursor = {
    i: 0,
    current: null,
    entries: [],
  };
  while (cursor.i < tokens.length) {
    cursor.i += applyToken(tokens, cursor);
  }
  if (cursor.current !== null) {
    cursor.entries.push(cursor.current);
  }
  return cursor.entries;
}

export interface ReadNetrcOptions {
  /** Override the path. Defaults to `~/.netrc`. */
  readonly path?: string;
}

/**
 * Look up the entry for `machine` in `~/.netrc` (or `opts.path`). Returns
 * `undefined` if the file is missing/unreadable or no entry matches. Falls back
 * to the `default` block when present and no exact match exists.
 */
export function readNetrcEntry(
  machine: string,
  opts: ReadNetrcOptions = {},
): NetrcLookupResult | undefined {
  const path = opts.path ?? DEFAULT_PATH;

  let body: string;
  let permissive = false;
  try {
    body = readFileSync(path, 'utf8');
    const mode = statSync(path).mode & 0o777;
    permissive = (mode & 0o077) !== 0;
  } catch {
    return undefined;
  }

  const entries = parse(body);
  const exact = entries.find((e) => e.machine === machine);
  const fallback = entries.find((e) => e.machine === 'default');
  const entry = exact ?? fallback;
  if (entry === undefined) {
    return undefined;
  }

  return {
    entry,
    permissive,
  };
}

/**
 * Convenience: return the `password` field for `machine`, or `undefined`.
 * Emits a one-line stderr warning if the file has group/world-read perms.
 */
export function readNetrcPassword(
  machine: string,
  opts: ReadNetrcOptions = {},
): string | undefined {
  const result = readNetrcEntry(machine, opts);
  if (result === undefined) {
    return undefined;
  }
  if (result.permissive) {
    process.stderr.write(
      `Warning: ${opts.path ?? DEFAULT_PATH} is group/world readable. Run: chmod 600 ${opts.path ?? DEFAULT_PATH}\n`,
    );
  }
  return result.entry.password;
}
