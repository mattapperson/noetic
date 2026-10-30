/**
 * The token reader the sense grammars share: whitespace-separated words and
 * double-quoted strings with `\"` and `\\` escapes.
 */

//#region Types

/** @public One token of matcher or summary text. */
export type SenseToken =
  | {
      readonly kind: 'word';
      readonly value: string;
    }
  | {
      readonly kind: 'quoted';
      readonly value: string;
    };

/** @public The tokens of a text, or why it cannot be read. */
export type TokenizeResult =
  | {
      readonly ok: true;
      readonly tokens: ReadonlyArray<SenseToken>;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

interface QuotedRead {
  readonly value: string;
  readonly end: number;
}

//#endregion

//#region Helpers

const WHITESPACE_RE = /\s/;

function isSpace(char: string | undefined): boolean {
  return char !== undefined && WHITESPACE_RE.test(char);
}

function readQuoted(text: string, start: number): QuotedRead | string {
  let value = '';
  let i = start + 1;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      return {
        value,
        end: i + 1,
      };
    }
    if (char !== '\\') {
      value += char;
      i++;
      continue;
    }
    const next = text[i + 1];
    if (next !== '"' && next !== '\\') {
      return `Unknown escape '\\${next ?? ''}' in a quoted string; only \\" and \\\\ are allowed.`;
    }
    value += next;
    i += 2;
  }
  return 'Unterminated quoted string.';
}

function readWord(text: string, start: number): QuotedRead | string {
  let i = start;
  while (i < text.length && !isSpace(text[i])) {
    if (text[i] === '"') {
      return 'A quote cannot start inside a word; separate it with a space.';
    }
    i++;
  }
  return {
    value: text.slice(start, i),
    end: i,
  };
}

//#endregion

//#region Public API

/** @public Splits text into words and quoted strings. */
export function tokenize(text: string): TokenizeResult {
  const tokens: SenseToken[] = [];
  let i = 0;
  while (i < text.length) {
    if (isSpace(text[i])) {
      i++;
      continue;
    }
    const quoted = text[i] === '"';
    const read = quoted ? readQuoted(text, i) : readWord(text, i);
    if (typeof read === 'string') {
      return {
        ok: false,
        reason: read,
      };
    }
    if (quoted && read.end < text.length && !isSpace(text[read.end])) {
      return {
        ok: false,
        reason: 'A quoted string must be followed by a space or the end.',
      };
    }
    tokens.push({
      kind: quoted ? 'quoted' : 'word',
      value: read.value,
    });
    i = read.end;
  }
  return {
    ok: true,
    tokens,
  };
}

/** @public Writes `value` as a double-quoted string, escaping `"` and `\`. */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** @public Writes `value` bare when it is one plain word, quoted otherwise. */
export function quoteIfNeeded(value: string): string {
  if (value.length > 0 && !/[\s"\\]/.test(value)) {
    return value;
  }
  return quote(value);
}

//#endregion
