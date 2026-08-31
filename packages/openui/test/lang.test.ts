import { describe, expect, test } from 'bun:test';
import {
  documentData,
  documentNodes,
  documentState,
  mergeDocument,
  OpenUiLangParser,
  parseDocument,
  resolveDocument,
  serializeDocument,
  serializeStatement,
} from '../src';
import { testLibrary } from './_helpers';

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
    expect(documentState(doc).map((s) => s.ref)).toEqual([
      '$tab',
    ]);
    expect(documentData(doc).map((s) => s.ref)).toEqual([
      'sales',
      'save',
    ]);
    expect(documentNodes(doc).map((s) => s.ref)).toEqual([
      'chart',
      'root',
    ]);
    expect(doc.diagnostics).toEqual([]);
  });

  test('preserves each statement source verbatim (no expression parse)', () => {
    const doc = parseDocument(
      [
        'a = Text("with \\"escape\\" and, comma")',
        'action = Action([@Run(save), @Set($tab, "next")])',
      ].join('\n'),
    );
    expect(doc.diagnostics).toEqual([]);
    expect(serializeStatement(doc.statements.a!)).toBe('a = Text("with \\"escape\\" and, comma")');
    expect(serializeStatement(doc.statements.action!)).toBe(
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
    expect(doc.statements.bad).toBeUndefined();
  });

  test('a malformed statement never enters the document or swallows later refs into it', () => {
    // An unclosed bracket glues every following line into one buffered
    // statement; that whole run must become a diagnostic, not a statement
    // that streams to clients or lands in surface recall.
    const doc = parseDocument(
      [
        'root = Card("ok")',
        'bad = Card(',
        'orphan = Progress("not a number")',
        'lost = Bogus("x")',
      ].join('\n'),
    );
    expect(Object.keys(doc.statements)).toEqual([
      'root',
    ]);
    expect(doc.diagnostics.length).toBe(1);
    expect(doc.diagnostics[0]?.source).toContain('bad = Card(');
  });

  test('an unterminated string is a diagnostic, not a statement', () => {
    const doc = parseDocument(
      [
        'root = Card("ok")',
        'a = Text("dangling',
      ].join('\n'),
    );
    expect(doc.root).toBe('root');
    expect(doc.statements.a).toBeUndefined();
    expect(doc.diagnostics.length).toBe(1);
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
    expect(doc.statements.a?.source).toBe('a = Text("3")');
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
    expect(completed.map((s) => s.ref)).toEqual([
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
    expect(completed.map((s) => s.ref)).toEqual([
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
    expect(merged.statements.a?.source).toBe('a = Text("2")');
  });
});

describe('resolveDocument (delegates to @openuidev/lang-core)', () => {
  test('resolves references and maps positional args to named props', () => {
    const doc = parseDocument(SAMPLE);
    const parsed = resolveDocument(doc, testLibrary().toJSONSchema());
    expect(parsed.root?.typeName).toBe('Stack');
    // `chart` reference is resolved inline into the root's children, positional
    // args mapped to named props (`title`) — proof lang-core did the resolving
    expect(JSON.stringify(parsed.root)).toContain('"title":"Sales"');
    // $state and data bindings are extracted
    expect(parsed.stateDeclarations.$tab).toBe('overview');
    expect(parsed.queryStatements.map((q) => q.statementId)).toContain('sales');
    expect(parsed.mutationStatements.map((m) => m.statementId)).toContain('save');
  });
});
