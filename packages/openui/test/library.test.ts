import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createLibrary, defineComponent, parseDocument, validateDocument } from '../src';
import { testLibrary } from './_helpers';

describe('createLibrary', () => {
  test('rejects duplicate component names', () => {
    expect(() =>
      createLibrary([
        defineComponent({
          name: 'Card',
        }),
        defineComponent({
          name: 'Card',
        }),
      ]),
    ).toThrow(/duplicate component name 'Card'/);
  });

  test('systemPrompt lists signatures with optionality and descriptions', () => {
    const prompt = testLibrary().systemPrompt();
    expect(prompt).toContain('- Card(title: string, children?: array) — A titled container');
    expect(prompt).toContain('- Progress(pct: number)');
    expect(prompt).toContain('one assignment statement per line');
  });
});

describe('validateDocument', () => {
  const lib = testLibrary();

  test('accepts a valid document including builtins and nested calls', () => {
    const doc = parseDocument(
      [
        '$tab = "a"',
        'sales = Query("sales_tool", {})',
        'root = Stack([Card("Title", [Text("hi")]), Action([@Run(sales)])])',
      ].join('\n'),
    );
    expect(validateDocument(lib, doc)).toEqual([]);
  });

  test('flags unknown components, including nested ones', () => {
    const doc = parseDocument('root = Stack([Sparkline([1, 2])])');
    const issues = validateDocument(lib, doc);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.component).toBe('Sparkline');
    expect(issues[0]?.ref).toBe('root');
  });

  test('flags arity overflow', () => {
    const doc = parseDocument('root = Text("a", "b")');
    const issues = validateDocument(lib, doc);
    expect(issues.some((i) => i.message.includes('too many arguments'))).toBe(true);
  });

  test('literal prop boundaries: 0 and 100 pass, 101 fails, refs skipped', () => {
    expect(validateDocument(lib, parseDocument('root = Progress(0)'))).toEqual([]);
    expect(validateDocument(lib, parseDocument('root = Progress(100)'))).toEqual([]);
    const over = validateDocument(lib, parseDocument('root = Progress(101)'));
    expect(over).toHaveLength(1);
    expect(over[0]?.message).toContain("prop 'pct'");
    // dynamic arg — statically unverifiable, must not be flagged
    expect(validateDocument(lib, parseDocument('root = Progress($pct)'))).toEqual([]);
  });

  test('exotic prop schemas degrade to "any" in the prompt', () => {
    const lib2 = createLibrary([
      defineComponent({
        name: 'Odd',
        props: z.object({
          fn: z.custom<() => void>((v) => typeof v === 'function'),
        }),
      }),
    ]);
    // A custom() schema has no JSON-schema type — it degrades to `any`. It
    // rejects undefined here, so it is also rendered as required.
    expect(lib2.systemPrompt()).toContain('- Odd(fn: any)');
  });
});
