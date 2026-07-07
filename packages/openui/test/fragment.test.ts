import { describe, expect, test } from 'bun:test';
import { fragment, parseDocument, uiBuiltin, uiRef, uiState } from '../src';
import { testLibrary } from './_helpers';

describe('fragment builder', () => {
  const f = fragment(testLibrary());

  test('compiles nested constructors to OpenUI Lang source', () => {
    const node = f.Card('Quote', [
      f.Text('hello'),
      f.Progress(40),
    ]);
    expect(node.dialect).toBe('openui-lang/0.5');
    expect(node.source).toBe('root = Card("Quote", [Text("hello"), Progress(40)])');
    // the emitted source parses back cleanly
    expect(parseDocument(node.source).diagnostics).toEqual([]);
  });

  test('plain objects and arrays become expression literals', () => {
    const node = f.Card('T', [
      {
        a: 1,
        b: [
          true,
          null,
        ],
      },
    ]);
    expect(node.source).toBe('root = Card("T", [{a: 1, b: [true, null]}])');
  });

  test('literal prop boundaries: 0 and 100 pass, 101 throws', () => {
    expect(f.Progress(0).source).toBe('root = Progress(0)');
    expect(f.Progress(100).source).toBe('root = Progress(100)');
    expect(() => f.Progress(101)).toThrow(/prop 'pct' rejects 101/);
  });

  test('arity overflow throws with the signature in the message', () => {
    expect(() => f.Text('a', 'b')).toThrow(/Text\(\) takes at most 1 argument/);
  });

  test('expression helpers: refs, state refs, builtin steps', () => {
    const node = f.Card('T', [
      uiRef('chart'),
      uiState('tab'),
      uiBuiltin('Run', uiRef('save')),
    ]);
    expect(node.source).toBe('root = Card("T", [chart, $tab, @Run(save)])');
  });
});
