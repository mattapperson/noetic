import { describe, expect, it } from 'bun:test';
import { shellQuote } from '../src/path';

describe('shellQuote', () => {
  it('wraps a simple string in single quotes', () => {
    expect(shellQuote('hello')).toBe("'hello'");
  });

  it('wraps a path with slashes unchanged', () => {
    expect(shellQuote('/local/data.txt')).toBe("'/local/data.txt'");
  });

  it('escapes a single quote using the close/escape/reopen trick', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it('escapes multiple single quotes', () => {
    expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
  });

  it('preserves dollar signs, backticks, and $( ) verbatim inside single quotes', () => {
    // These are only dangerous inside double quotes. Inside single
    // quotes they are literal.
    const payload = '$(rm -rf /) `whoami` $HOME';
    expect(shellQuote(payload)).toBe(`'${payload}'`);
  });

  it('preserves backslashes verbatim', () => {
    expect(shellQuote('a\\b')).toBe("'a\\b'");
  });

  it('preserves newlines inside the quoted value', () => {
    expect(shellQuote('line1\nline2')).toBe("'line1\nline2'");
  });

  it('preserves non-ASCII unicode', () => {
    expect(shellQuote('café/文件.txt')).toBe("'café/文件.txt'");
  });

  it('handles empty strings', () => {
    expect(shellQuote('')).toBe("''");
  });

  it('closes and reopens cleanly around injection attempts', () => {
    const attempts = [
      "'; rm -rf /; #",
      '$(rm -rf /)',
      '`id`',
      "' && echo pwned #",
      '\\n; echo injected',
    ];
    for (const payload of attempts) {
      const quoted = shellQuote(payload);
      // The only unescaped single-quote characters allowed in the output
      // are the very first and very last. Any intermediate single quote
      // is part of the close-escape-reopen sequence `'\''`.
      const firstUnescapedInner = quoted.slice(1, -1);
      // Count of literal single-quote characters must equal the count
      // in the original, each expanded to `'\''` (4 chars, one of which
      // is a quote in the boundary positions). We check the structure:
      // every `'` that appears inside the wrapper must be immediately
      // followed by `\\''` (close, escaped quote, reopen) or preceded
      // by the same.
      const normalized = firstUnescapedInner.replace(/'\\''/g, '<Q>');
      expect(normalized.includes("'")).toBe(false);
      // And the original content must round-trip when we reverse the
      // escape (replace the sentinel back with a quote).
      const roundTripped = normalized.replace(/<Q>/g, "'");
      expect(roundTripped).toBe(payload);
    }
  });
});
