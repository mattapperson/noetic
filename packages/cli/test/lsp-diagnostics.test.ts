import { describe, expect, it } from 'bun:test';

import type { Diagnostic } from 'vscode-languageserver-protocol';

import { DiagnosticStore, mergeDiagnostics } from '../src/lsp/diagnostics.js';

function diag(line: number, message: string, source?: string): Diagnostic {
  return {
    range: {
      start: {
        line,
        character: 0,
      },
      end: {
        line,
        character: 3,
      },
    },
    message,
    source,
  };
}

describe('DiagnosticStore', () => {
  it('recordPush replaces prior diagnostics for a uri', () => {
    const store = new DiagnosticStore();
    store.recordPush('file:///a', [
      diag(1, 'old'),
    ]);
    store.recordPush('file:///a', [
      diag(2, 'new'),
    ]);
    expect(store.getPushed('file:///a').map((d) => d.message)).toEqual([
      'new',
    ]);
  });

  it('clear removes a single uri', () => {
    const store = new DiagnosticStore();
    store.recordPush('file:///a', [
      diag(1, 'x'),
    ]);
    store.recordPush('file:///b', [
      diag(1, 'y'),
    ]);
    store.clear('file:///a');
    expect(store.getPushed('file:///a')).toEqual([]);
    expect(store.getPushed('file:///b').length).toBe(1);
  });

  it('clearAll empties the store', () => {
    const store = new DiagnosticStore();
    store.recordPush('file:///a', [
      diag(1, 'x'),
    ]);
    store.clearAll();
    expect(store.getPushed('file:///a')).toEqual([]);
  });

  it('returns empty array for uris with no recorded diagnostics', () => {
    const store = new DiagnosticStore();
    expect(store.getPushed('file:///never-seen')).toEqual([]);
  });
});

describe('mergeDiagnostics', () => {
  it('preserves pushed diagnostics in order', () => {
    const pushed = [
      diag(1, 'a'),
      diag(2, 'b'),
    ];
    const merged = mergeDiagnostics(pushed, []);
    expect(merged.map((d) => d.message)).toEqual([
      'a',
      'b',
    ]);
  });

  it('appends pulled-only diagnostics after pushed', () => {
    const pushed = [
      diag(1, 'a'),
    ];
    const pulled = [
      diag(3, 'c'),
    ];
    const merged = mergeDiagnostics(pushed, pulled);
    expect(merged.map((d) => d.message)).toEqual([
      'a',
      'c',
    ]);
  });

  it('deduplicates overlapping entries by (range, message, source)', () => {
    const shared = diag(1, 'duplicate', 'tsserver');
    const merged = mergeDiagnostics(
      [
        shared,
      ],
      [
        shared,
      ],
    );
    expect(merged.length).toBe(1);
  });

  it('treats different sources as distinct even with same range and message', () => {
    const a = diag(1, 'duplicate', 'tsserver');
    const b = diag(1, 'duplicate', 'eslint');
    const merged = mergeDiagnostics(
      [
        a,
      ],
      [
        b,
      ],
    );
    expect(merged.length).toBe(2);
  });

  it('treats missing source the same way across both channels', () => {
    const a = diag(1, 'x');
    const b = diag(1, 'x');
    const merged = mergeDiagnostics(
      [
        a,
      ],
      [
        b,
      ],
    );
    expect(merged.length).toBe(1);
  });
});
