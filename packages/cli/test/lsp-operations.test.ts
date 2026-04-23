import { describe, expect, it } from 'bun:test';

import type { Location, LocationLink } from 'vscode-languageserver-protocol';
import { SymbolKind } from 'vscode-languageserver-protocol';

import {
  extractWordAtPosition,
  formatCallHierarchyPrepareResult,
  formatDefinitionResult,
  formatDocumentSymbolsResult,
  formatHover,
  formatIncomingCallsResult,
  formatOutgoingCallsResult,
  formatReferencesResult,
  formatWorkspaceSymbolsResult,
  LspOperation,
} from '../src/lsp/operations.js';

describe('LspOperation enum', () => {
  it('has exactly the 9 operations the plan promises', () => {
    const values = Object.values(LspOperation);
    expect(values).toHaveLength(9);
    expect(values).toContain('goToDefinition');
    expect(values).toContain('findReferences');
    expect(values).toContain('hover');
    expect(values).toContain('documentSymbol');
    expect(values).toContain('workspaceSymbol');
    expect(values).toContain('goToImplementation');
    expect(values).toContain('prepareCallHierarchy');
    expect(values).toContain('incomingCalls');
    expect(values).toContain('outgoingCalls');
  });
});

describe('formatHover', () => {
  it('returns placeholder when hover is null', () => {
    expect(formatHover(null)).toContain('No hover');
  });

  it('extracts string contents', () => {
    expect(
      formatHover({
        contents: 'just text',
      }),
    ).toBe('just text');
  });

  it('flattens MarkupContent objects', () => {
    expect(
      formatHover({
        contents: {
          kind: 'markdown',
          value: '# Title',
        },
      }),
    ).toBe('# Title');
  });

  it('joins array marked-strings with blank lines', () => {
    const out = formatHover({
      contents: [
        {
          language: 'ts',
          value: 'part-1',
        },
        {
          language: 'ts',
          value: 'part-2',
        },
      ],
    });
    expect(out).toContain('part-1');
    expect(out).toContain('part-2');
  });
});

describe('formatDefinitionResult', () => {
  const loc: Location = {
    uri: 'file:///tmp/foo.ts',
    range: {
      start: {
        line: 9,
        character: 4,
      },
      end: {
        line: 9,
        character: 10,
      },
    },
  };

  it('handles null', () => {
    expect(formatDefinitionResult(null)).toContain('No definition');
  });

  it('formats a single Location as a list item (1-indexed line)', () => {
    const out = formatDefinitionResult(loc);
    expect(out).toContain('/tmp/foo.ts');
    expect(out).toContain(':10:'); // line 9 → display 10
  });

  it('handles empty arrays', () => {
    expect(formatDefinitionResult([])).toContain('No definition');
  });

  it('formats LocationLink arrays using targetUri/targetRange', () => {
    const link: LocationLink = {
      targetUri: 'file:///tmp/bar.ts',
      targetRange: loc.range,
      targetSelectionRange: loc.range,
    };
    const out = formatDefinitionResult([
      link,
    ]);
    expect(out).toContain('/tmp/bar.ts');
  });
});

describe('formatReferencesResult', () => {
  it('says "No references" for null or empty', () => {
    expect(formatReferencesResult(null)).toContain('No references');
    expect(formatReferencesResult([])).toContain('No references');
  });

  it('lists references with positions', () => {
    const out = formatReferencesResult([
      {
        uri: 'file:///a.ts',
        range: {
          start: {
            line: 0,
            character: 0,
          },
          end: {
            line: 0,
            character: 3,
          },
        },
      },
    ]);
    expect(out).toContain('/a.ts');
    expect(out).toContain(':1:');
  });
});

describe('formatDocumentSymbolsResult', () => {
  it('returns placeholder on null/empty', () => {
    expect(formatDocumentSymbolsResult(null, 'x.ts')).toContain('No symbols');
    expect(formatDocumentSymbolsResult([], 'x.ts')).toContain('No symbols');
  });

  it('renders a DocumentSymbol tree with indentation for children', () => {
    const out = formatDocumentSymbolsResult(
      [
        {
          name: 'parent',
          kind: SymbolKind.Class,
          range: {
            start: {
              line: 0,
              character: 0,
            },
            end: {
              line: 10,
              character: 0,
            },
          },
          selectionRange: {
            start: {
              line: 0,
              character: 6,
            },
            end: {
              line: 0,
              character: 12,
            },
          },
          children: [
            {
              name: 'child',
              kind: SymbolKind.Method,
              range: {
                start: {
                  line: 1,
                  character: 2,
                },
                end: {
                  line: 5,
                  character: 2,
                },
              },
              selectionRange: {
                start: {
                  line: 1,
                  character: 4,
                },
                end: {
                  line: 1,
                  character: 9,
                },
              },
            },
          ],
        },
      ],
      'x.ts',
    );
    const lines = out.split('\n');
    expect(lines[0]).toContain('class parent');
    expect(lines[1]).toMatch(/^\s{2}-\s+method child/);
  });

  it('renders SymbolInformation as a flat list', () => {
    const out = formatDocumentSymbolsResult(
      [
        {
          name: 'foo',
          kind: SymbolKind.Function,
          location: {
            uri: 'file:///y.ts',
            range: {
              start: {
                line: 2,
                character: 0,
              },
              end: {
                line: 2,
                character: 3,
              },
            },
          },
        },
      ],
      'x.ts',
    );
    expect(out).toContain('function foo');
    expect(out).toContain('/y.ts');
  });
});

describe('formatWorkspaceSymbolsResult', () => {
  it('returns placeholder on null or empty', () => {
    expect(formatWorkspaceSymbolsResult(null)).toContain('No results');
    expect(formatWorkspaceSymbolsResult([])).toContain('No results');
  });

  it('formats SymbolInformation entries', () => {
    const out = formatWorkspaceSymbolsResult([
      {
        name: 'helper',
        kind: SymbolKind.Function,
        location: {
          uri: 'file:///util.ts',
          range: {
            start: {
              line: 0,
              character: 0,
            },
            end: {
              line: 0,
              character: 6,
            },
          },
        },
      },
    ]);
    expect(out).toContain('function helper');
    expect(out).toContain('/util.ts');
  });
});

describe('formatCallHierarchy', () => {
  it('prepare placeholder messages', () => {
    expect(formatCallHierarchyPrepareResult(null)).toContain('No hierarchy');
    expect(formatCallHierarchyPrepareResult([])).toContain('No hierarchy');
  });

  it('incoming placeholder messages', () => {
    expect(formatIncomingCallsResult(null)).toContain('No incoming');
    expect(formatIncomingCallsResult([])).toContain('No incoming');
  });

  it('outgoing placeholder messages', () => {
    expect(formatOutgoingCallsResult(null)).toContain('No outgoing');
    expect(formatOutgoingCallsResult([])).toContain('No outgoing');
  });
});

describe('extractWordAtPosition', () => {
  const text = 'const fooBar = baz_qux()';

  it('returns the identifier under the cursor', () => {
    expect(
      extractWordAtPosition(text, {
        line: 0,
        character: 7,
      }),
    ).toBe('fooBar');
  });

  it('returns null when cursor is between identifiers on a non-word char', () => {
    // position 13 sits on '=' — outside every identifier match
    expect(
      extractWordAtPosition(text, {
        line: 0,
        character: 13,
      }),
    ).toBeNull();
  });

  it('returns null for out-of-range line', () => {
    expect(
      extractWordAtPosition(text, {
        line: 5,
        character: 0,
      }),
    ).toBeNull();
  });

  it('matches identifiers with underscores and digits', () => {
    expect(
      extractWordAtPosition(text, {
        line: 0,
        character: 18,
      }),
    ).toBe('baz_qux');
  });
});
