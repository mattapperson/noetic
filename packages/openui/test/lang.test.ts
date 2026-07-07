import { describe, expect, test } from 'bun:test';
import {
  documentData,
  documentNodes,
  documentState,
  mergeDocument,
  OpenUiLangParser,
  parseDocument,
  serializeAssignment,
  serializeDocument,
} from '../src';

const SAMPLE = [
  '$tab = "overview"',
  'sales = Query("sales_tool", {region: $tab})',
  'save = Mutation("save_tool", {})',
  'chart = Card("Sales", [Text("hello")])',
  'root = Stack([chart])',
].join('\n');

describe('parseDocument', () => {
  test('classifies statements and tracks root', () => {
    const doc = parseDocument(SAMPLE);
    expect(doc.root).toBe('root');
    expect(documentState(doc).map((a) => a.ref)).toEqual([
      '$tab',
    ]);
    expect(documentData(doc).map((a) => a.ref)).toEqual([
      'sales',
      'save',
    ]);
    expect(documentNodes(doc).map((a) => a.ref)).toEqual([
      'chart',
      'root',
    ]);
    expect(doc.diagnostics).toEqual([]);
  });

  test('parses expression forms: literals, refs, state, member, builtin calls', () => {
    const doc = parseDocument(
      [
        'a = Text("with \\"escape\\" and, comma")',
        'b = Progress(-12.5)',
        'c = Card(data.rows.title, [true, false, null])',
        'action = Action([@Run(save), @Set($tab, "next")])',
      ].join('\n'),
    );
    expect(doc.diagnostics).toEqual([]);
    const a = doc.assignments.a;
    expect(a).toBeDefined();
    if (a?.expr.kind !== 'call') {
      throw new Error('expected call');
    }
    expect(a.expr.args[0]).toEqual({
      kind: 'literal',
      value: 'with "escape" and, comma',
    });
    expect(serializeAssignment(doc.assignments.action!)).toBe(
      'action = Action([@Run(save), @Set($tab, "next")])',
    );
  });

  test('prose, fences, and broken lines become diagnostics or are skipped', () => {
    const doc = parseDocument(
      [
        '```openui',
        'Sure! Here is your UI:',
        'root = Card("ok")',
        'bad = Card(',
        '```',
      ].join('\n'),
    );
    expect(doc.root).toBe('root');
    // fence lines skipped silently; prose + unterminated statement → diagnostics
    expect(doc.diagnostics.length).toBe(2);
    expect(doc.assignments.bad).toBeUndefined();
  });

  test('re-assignment replaces and moves ref to end of order', () => {
    const doc = parseDocument(
      [
        'a = Text("1")',
        'b = Text("2")',
        'a = Text("3")',
      ].join('\n'),
    );
    expect(doc.order).toEqual([
      'b',
      'a',
    ]);
    const a = doc.assignments.a;
    if (a?.expr.kind !== 'call' || a.expr.args[0]?.kind !== 'literal') {
      throw new Error('expected call with literal');
    }
    expect(a.expr.args[0].value).toBe('3');
  });
});

describe('OpenUiLangParser streaming', () => {
  test('statements complete across arbitrary delta boundaries', () => {
    const parser = new OpenUiLangParser();
    const completed = [
      ...parser.push('cha'),
      ...parser.push('rt = Card("Sa'),
      ...parser.push('les")\nroot = St'),
      ...parser.push('ack([chart])\n'),
    ];
    expect(completed.map((a) => a.ref)).toEqual([
      'chart',
      'root',
    ]);
    const doc = parser.end();
    expect(doc.root).toBe('root');
  });

  test('newlines inside brackets and strings do not split statements', () => {
    const parser = new OpenUiLangParser();
    const completed = [
      ...parser.push('root = Stack([\n  Text("a\\nb"),\n  Text("c")\n])\n'),
    ];
    expect(completed.map((a) => a.ref)).toEqual([
      'root',
    ]);
  });

  test('end() flushes a trailing unterminated line', () => {
    const parser = new OpenUiLangParser();
    expect(parser.push('root = Text("tail")')).toEqual([]);
    const doc = parser.end();
    expect(doc.root).toBe('root');
  });
});

describe('serializeDocument / mergeDocument', () => {
  test('serialize → parse round-trips', () => {
    const doc = parseDocument(SAMPLE);
    const reparsed = parseDocument(serializeDocument(doc));
    expect(reparsed.order).toEqual(doc.order);
    expect(serializeDocument(reparsed)).toBe(serializeDocument(doc));
  });

  test('merge replaces refs, appends new ones, and keeps base root when incoming has none', () => {
    const base = parseDocument(
      [
        'a = Text("1")',
        'root = Stack([a])',
      ].join('\n'),
    );
    const incoming = parseDocument(
      [
        'a = Text("2")',
        'b = Text("new")',
      ].join('\n'),
    );
    const merged = mergeDocument(base, incoming);
    expect(merged.root).toBe('root');
    expect(merged.order).toEqual([
      'root',
      'a',
      'b',
    ]);
    const a = merged.assignments.a;
    if (a?.expr.kind !== 'call' || a.expr.args[0]?.kind !== 'literal') {
      throw new Error('expected call with literal');
    }
    expect(a.expr.args[0].value).toBe('2');
  });
});
