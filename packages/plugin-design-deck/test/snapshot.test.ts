import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSnapshot, slugify, writeSnapshot } from '../src/snapshot.js';

describe('slugify', () => {
  test('lowercase, alnum + dashes only', () => {
    expect(slugify('Pick a Database!!')).toBe('pick-a-database');
  });

  test('collapses repeated non-alnum', () => {
    expect(slugify('a   b___c')).toBe('a-b-c');
  });

  test('falls back to "deck" for empty input', () => {
    expect(slugify('!!!')).toBe('deck');
  });

  test('caps length', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(60);
  });
});

describe('writeSnapshot', () => {
  test('round-trips a deck + selections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dd-snap-'));
    const deck = {
      title: 'Pick one',
      slides: [
        {
          id: 'pick',
          title: 'Pick one',
          context: 'Choose A or B.',
          options: [
            {
              label: 'A',
              description: 'first',
              previewBlocks: [],
            },
            {
              label: 'B',
              description: 'second',
              previewBlocks: [],
            },
          ],
        },
      ],
    };
    const selections = {
      pick: 'A',
    };
    const now = new Date('2026-04-20T19:00:00.000Z');
    const result = writeSnapshot({
      dataDir: dir,
      deck,
      selections,
      status: 'submitted',
      now,
    });
    expect(result.dir.endsWith('-submitted')).toBe(true);
    const restored = readSnapshot(result.jsonPath);
    expect(restored.deck.title).toBe('Pick one');
    expect(restored.selections).toEqual(selections);
    expect(restored.status).toBe('submitted');
    const summary = readFileSync(result.summaryPath, 'utf8');
    expect(summary).toContain('# Pick one');
    expect(summary).toContain('- **Pick one** — A');
  });
});
