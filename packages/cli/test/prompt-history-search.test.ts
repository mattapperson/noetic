import { describe, expect, test } from 'bun:test';
import { createSearchModeState, findReverseMatch } from '../src/tui/utils/prompt-history-search.js';

const ENTRIES = [
  'tell me a story, 1000 words',
  'fix the scroll bug',
  'tell me a joke',
  '/badcmd1',
  'tell me about typescript',
];

describe('createSearchModeState', () => {
  test('initialises with empty query and matchIndex 0', () => {
    const s = createSearchModeState('draft buffer');
    expect(s.query).toBe('');
    expect(s.matchIndex).toBe(0);
    expect(s.savedBuffer).toBe('draft buffer');
  });
});

describe('findReverseMatch', () => {
  test('empty query returns the entry at fromIndex (parked behaviour)', () => {
    expect(findReverseMatch(ENTRIES, 0, '')).toEqual({
      value: 'tell me a story, 1000 words',
      index: 0,
    });
    expect(findReverseMatch(ENTRIES, 2, '')).toEqual({
      value: 'tell me a joke',
      index: 2,
    });
  });

  test('empty query past the end returns no match', () => {
    expect(findReverseMatch(ENTRIES, 99, '')).toEqual({
      value: '',
      index: -1,
    });
  });

  test('substring match is case-insensitive', () => {
    expect(findReverseMatch(ENTRIES, 0, 'STORY')).toEqual({
      value: 'tell me a story, 1000 words',
      index: 0,
    });
  });

  test('walks newest → oldest, returns the first hit at or after fromIndex', () => {
    expect(findReverseMatch(ENTRIES, 0, 'tell')).toEqual({
      value: 'tell me a story, 1000 words',
      index: 0,
    });
    expect(findReverseMatch(ENTRIES, 1, 'tell')).toEqual({
      value: 'tell me a joke',
      index: 2,
    });
    expect(findReverseMatch(ENTRIES, 3, 'tell')).toEqual({
      value: 'tell me about typescript',
      index: 4,
    });
  });

  test('cycling Ctrl+R: matchIndex+1 each press advances through hits', () => {
    let idx = 0;
    const hits: string[] = [];
    while (true) {
      const r = findReverseMatch(ENTRIES, idx, 'tell');
      if (r.index < 0) {
        break;
      }
      hits.push(r.value);
      idx = r.index + 1;
    }
    expect(hits).toEqual([
      'tell me a story, 1000 words',
      'tell me a joke',
      'tell me about typescript',
    ]);
  });

  test('returns no match when query never appears', () => {
    expect(findReverseMatch(ENTRIES, 0, 'zzz')).toEqual({
      value: '',
      index: -1,
    });
  });

  test('returns no match for an empty entries array', () => {
    expect(findReverseMatch([], 0, 'anything')).toEqual({
      value: '',
      index: -1,
    });
  });

  test('defensive: negative fromIndex returns no match (does not loop)', () => {
    expect(findReverseMatch(ENTRIES, -1, 'tell')).toEqual({
      value: '',
      index: -1,
    });
  });
});
