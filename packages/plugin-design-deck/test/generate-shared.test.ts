import { describe, expect, test } from 'bun:test';

import { extractJson } from '../src/generate/shared.js';

describe('extractJson', () => {
  test('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({
      a: 1,
    });
  });

  test('strips ```json fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({
      a: 1,
    });
  });

  test('strips bare ``` fences', () => {
    expect(extractJson('```\n[1,2,3]\n```')).toEqual([
      1,
      2,
      3,
    ]);
  });

  test('finds JSON embedded in prose', () => {
    expect(extractJson('here you go: {"ok":true} — enjoy')).toEqual({
      ok: true,
    });
  });

  test('returns null on unparseable input', () => {
    expect(extractJson('nothing to see here')).toBeNull();
  });
});
