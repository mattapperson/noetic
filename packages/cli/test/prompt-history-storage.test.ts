/**
 * Tests for the persistent prompt-history file store.
 *
 * We never touch the user's real `~/.noetic/prompt-history.jsonl` — every
 * call routes through a temp dir via the optional `filePath` arg.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendPromptHistory,
  loadPromptHistory,
  maybeCompactPromptHistory,
} from '../src/tui/utils/prompt-history-storage.js';

let dir = '';
let file = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'noetic-prompt-history-'));
  file = join(dir, 'prompt-history.jsonl');
});

afterEach(async () => {
  await rm(dir, {
    recursive: true,
    force: true,
  });
});

describe('loadPromptHistory', () => {
  test('returns an empty array when the file does not exist', async () => {
    expect(await loadPromptHistory(file)).toEqual([]);
  });

  test('parses one entry per line (oldest → newest)', async () => {
    await writeFile(
      file,
      [
        '{"text":"first"}',
        '{"text":"second"}',
        '{"text":"third"}',
        '',
      ].join('\n'),
      'utf8',
    );
    expect(await loadPromptHistory(file)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  test('caps the returned array at MAX_ENTRIES (returns the newest tail)', async () => {
    // Write 1300 records; MAX_ENTRIES is 1000. Load must return the last
    // 1000 — defends a long-lived `~/.noetic/prompt-history.jsonl` from
    // blowing up in-memory state before the slow compaction path runs.
    const lines: string[] = [];
    for (let i = 0; i < 1300; i++) {
      lines.push(
        JSON.stringify({
          text: `entry-${i}`,
        }),
      );
    }
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
    const loaded = await loadPromptHistory(file);
    expect(loaded).toHaveLength(1000);
    expect(loaded[0]).toBe('entry-300');
    expect(loaded[999]).toBe('entry-1299');
  });

  test('skips malformed JSON lines without dropping subsequent valid records', async () => {
    await writeFile(
      file,
      [
        '{"text":"good1"}',
        '{not json}',
        '{"text":"good2"}',
        '{"text":""}', // empty text — schema rejects.
        '{"other":"missing text"}',
        '{"text":"good3"}',
      ].join('\n'),
      'utf8',
    );
    expect(await loadPromptHistory(file)).toEqual([
      'good1',
      'good2',
      'good3',
    ]);
  });
});

describe('appendPromptHistory', () => {
  test('creates the parent directory and writes a single JSONL record', async () => {
    const nested = join(dir, 'sub', 'nested.jsonl');
    await appendPromptHistory('hello world', nested);
    const contents = await readFile(nested, 'utf8');
    expect(contents).toBe(
      `${JSON.stringify({
        text: 'hello world',
      })}\n`,
    );
  });

  test('appends in order — the file grows newest-at-bottom', async () => {
    await appendPromptHistory('first', file);
    await appendPromptHistory('second', file);
    await appendPromptHistory('third', file);
    expect(await loadPromptHistory(file)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  test('trims and ignores empty / whitespace-only submissions', async () => {
    await appendPromptHistory('   ', file);
    await appendPromptHistory('', file);
    expect(await loadPromptHistory(file)).toEqual([]);
    await appendPromptHistory('  real text  ', file);
    expect(await loadPromptHistory(file)).toEqual([
      'real text',
    ]);
  });
});

describe('maybeCompactPromptHistory', () => {
  test('no-ops when the file is below the threshold', async () => {
    for (let i = 0; i < 50; i++) {
      await appendPromptHistory(`entry-${i}`, file);
    }
    expect(await maybeCompactPromptHistory(file)).toBeNull();
    expect(await loadPromptHistory(file)).toHaveLength(50);
  });

  test('trims to the last MAX_ENTRIES when the file exceeds COMPACT_THRESHOLD', async () => {
    // Write 1300 raw records directly so we exceed COMPACT_THRESHOLD
    // (MAX_ENTRIES + 200 = 1200) without 1300 append round-trips.
    const lines: string[] = [];
    for (let i = 0; i < 1300; i++) {
      lines.push(
        JSON.stringify({
          text: `entry-${i}`,
        }),
      );
    }
    await writeFile(file, `${lines.join('\n')}\n`, 'utf8');
    const kept = await maybeCompactPromptHistory(file);
    expect(kept).toBe(1000);
    const loaded = await loadPromptHistory(file);
    expect(loaded).toHaveLength(1000);
    // Newest are kept (the last 1000 of 1300 → entry-300 through entry-1299).
    expect(loaded[0]).toBe('entry-300');
    expect(loaded[999]).toBe('entry-1299');
  });
});
