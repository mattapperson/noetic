/**
 * Pure helper tests for `ui/diff-utils.ts` and `git.ts`'s exported
 * classifiers — covers buildDiff, flattenHunks, gutterWidth, markerFor, and
 * classifyFilePath / isIncludedReviewPath through the `__testing` hatch.
 */

import { describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';

import { __testing } from '../../src/commands/builtins/diff-review/git.js';
import { ReviewFileKind } from '../../src/commands/builtins/diff-review/types.js';
import {
  buildDiff,
  DiffLineKind,
  flattenHunks,
  gutterWidth,
  markerFor,
} from '../../src/tui/commands/diff-review-ui/diff-utils.js';

const { classifyFilePath, isIncludedReviewPath } = __testing;

describe('buildDiff', () => {
  test('returns null when contents are identical', () => {
    expect(
      buildDiff({
        originalContent: 'hello\n',
        modifiedContent: 'hello\n',
        originalPath: 'a.txt',
        modifiedPath: 'a.txt',
      }),
    ).toBeNull();
  });

  test('emits add/del lines for a single-line change', () => {
    const diff = buildDiff({
      originalContent: 'hello\n',
      modifiedContent: 'hello\nworld\n',
      originalPath: 'a.txt',
      modifiedPath: 'a.txt',
    });
    assert(diff !== null);
    expect(diff.totals.added).toBe(1);
    expect(diff.totals.removed).toBe(0);
    const lines = flattenHunks(diff);
    const addedLine = lines.find((l) => l.kind === DiffLineKind.Add);
    expect(addedLine?.text).toBe('world');
  });

  test('returns null for empty originals when content matches', () => {
    expect(
      buildDiff({
        originalContent: '',
        modifiedContent: '',
        originalPath: 'a.txt',
        modifiedPath: 'a.txt',
      }),
    ).toBeNull();
  });
});

describe('flattenHunks + gutterWidth', () => {
  test('gutterWidth scales with the largest line number', () => {
    const diff = buildDiff({
      originalContent: 'a\nb\nc\n',
      modifiedContent: 'a\nB\nc\n',
      originalPath: 'a.txt',
      modifiedPath: 'a.txt',
    });
    assert(diff !== null);
    expect(gutterWidth(diff)).toBe(1);
  });

  test('flattenHunks preserves order across hunks', () => {
    const original = Array.from(
      {
        length: 30,
      },
      (_, i) => `line${i}`,
    ).join('\n');
    const modified = original.replace('line5', 'LINE5').replace('line25', 'LINE25');
    const diff = buildDiff({
      originalContent: original,
      modifiedContent: modified,
      originalPath: 'a.txt',
      modifiedPath: 'a.txt',
    });
    assert(diff !== null);
    const flat = flattenHunks(diff);
    const adds = flat.filter((l) => l.kind === DiffLineKind.Add).map((l) => l.text);
    const dels = flat.filter((l) => l.kind === DiffLineKind.Del).map((l) => l.text);
    expect(adds).toEqual([
      'LINE5',
      'LINE25',
    ]);
    expect(dels).toEqual([
      'line5',
      'line25',
    ]);
  });
});

describe('markerFor', () => {
  test('returns + for add', () => {
    expect(
      markerFor({
        kind: DiffLineKind.Add,
        text: 'x',
      }),
    ).toBe('+');
  });

  test('returns - for del', () => {
    expect(
      markerFor({
        kind: DiffLineKind.Del,
        text: 'x',
      }),
    ).toBe('-');
  });

  test('returns space for context', () => {
    expect(
      markerFor({
        kind: DiffLineKind.Ctx,
        text: 'x',
      }),
    ).toBe(' ');
  });
});

describe('classifyFilePath', () => {
  test('classifies png as image with mime', () => {
    const meta = classifyFilePath('a/b/c.png');
    expect(meta.kind).toBe(ReviewFileKind.Image);
    expect(meta.mimeType).toBe('image/png');
  });

  test('classifies jpg as image jpeg', () => {
    expect(classifyFilePath('photo.JPG').mimeType).toBe('image/jpeg');
  });

  test('classifies pdf as binary with no mime', () => {
    const meta = classifyFilePath('doc.pdf');
    expect(meta.kind).toBe(ReviewFileKind.Binary);
    expect(meta.mimeType).toBeNull();
  });

  test('classifies unknown extension as text', () => {
    const meta = classifyFilePath('readme.md');
    expect(meta.kind).toBe(ReviewFileKind.Text);
    expect(meta.mimeType).toBeNull();
  });

  test('extension lookup is case-insensitive', () => {
    expect(classifyFilePath('logo.PNG').kind).toBe(ReviewFileKind.Image);
    expect(classifyFilePath('archive.ZIP').kind).toBe(ReviewFileKind.Binary);
  });
});

describe('isIncludedReviewPath', () => {
  test('skips minified js and css', () => {
    expect(isIncludedReviewPath('vendor.min.js')).toBe(false);
    expect(isIncludedReviewPath('site.min.css')).toBe(false);
  });

  test('keeps regular sources', () => {
    expect(isIncludedReviewPath('src/foo.ts')).toBe(true);
    expect(isIncludedReviewPath('package.json')).toBe(true);
  });

  test('rejects empty paths', () => {
    expect(isIncludedReviewPath('')).toBe(false);
  });
});
