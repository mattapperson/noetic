import { describe, expect, test } from 'bun:test';
import { parseUnifiedDiff } from '../src/tui/diff/parse-unified-diff.js';

describe('parseUnifiedDiff', () => {
  test('returns null for empty input', () => {
    expect(parseUnifiedDiff('')).toBeNull();
    expect(parseUnifiedDiff('   \n  ')).toBeNull();
  });

  test('returns null for junk input parsePatch rejects', () => {
    expect(parseUnifiedDiff('not a diff')).toBeNull();
  });

  test('parses a simple single-hunk add/remove/ctx diff', () => {
    const diff = `--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,2 @@
 keep
-old
+new
`;
    const parsed = parseUnifiedDiff(diff);
    expect(parsed).not.toBeNull();
    if (!parsed) {
      return;
    }
    expect(parsed.totals.added).toBe(1);
    expect(parsed.totals.removed).toBe(1);
    expect(parsed.hunks.length).toBe(1);
    const hunk = parsed.hunks[0];
    if (!hunk) {
      throw new Error('expected hunk');
    }
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    expect(hunk.lines.map((l) => l.kind)).toEqual([
      'ctx',
      'del',
      'add',
    ]);
    const ctx = hunk.lines[0];
    const del = hunk.lines[1];
    const add = hunk.lines[2];
    expect(ctx?.oldLine).toBe(1);
    expect(ctx?.newLine).toBe(1);
    expect(del?.oldLine).toBe(2);
    expect(del?.newLine).toBeUndefined();
    expect(add?.oldLine).toBeUndefined();
    expect(add?.newLine).toBe(2);
  });

  test('parses a multi-hunk diff with correct line numbering across hunks', () => {
    const diff = `--- a/f.ts
+++ b/f.ts
@@ -1,2 +1,3 @@
 a
+b
 c
@@ -10,1 +11,2 @@
 z
+zz
`;
    const parsed = parseUnifiedDiff(diff);
    if (!parsed) {
      throw new Error('expected parsed');
    }
    expect(parsed.hunks.length).toBe(2);
    expect(parsed.totals.added).toBe(2);
    expect(parsed.totals.removed).toBe(0);
    expect(parsed.hunks[1]?.oldStart).toBe(10);
    expect(parsed.hunks[1]?.newStart).toBe(11);
  });

  test('add-only hunk: totals.removed === 0', () => {
    const diff = '--- a/f\n+++ b/f\n@@ -0,0 +1,2 @@\n+one\n+two\n';
    const parsed = parseUnifiedDiff(diff);
    if (!parsed) {
      throw new Error('expected parsed');
    }
    expect(parsed.totals.added).toBe(2);
    expect(parsed.totals.removed).toBe(0);
  });

  test('delete-only hunk: totals.added === 0', () => {
    const diff = '--- a/f\n+++ b/f\n@@ -1,2 +0,0 @@\n-one\n-two\n';
    const parsed = parseUnifiedDiff(diff);
    if (!parsed) {
      throw new Error('expected parsed');
    }
    expect(parsed.totals.added).toBe(0);
    expect(parsed.totals.removed).toBe(2);
  });

  test('skips "\\ No newline at end of file" sentinel lines', () => {
    const diff = `--- a/f
+++ b/f
@@ -1,1 +1,1 @@
-old
\\ No newline at end of file
+new
`;
    const parsed = parseUnifiedDiff(diff);
    if (!parsed) {
      throw new Error('expected parsed');
    }
    // The sentinel must not appear as a DiffLine
    for (const line of parsed.hunks[0]?.lines ?? []) {
      expect(line.text.startsWith(' No newline')).toBe(false);
    }
    expect(parsed.totals.added).toBe(1);
    expect(parsed.totals.removed).toBe(1);
  });
});
