import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadVibesFromFile } from '../src/working-vibes/file.js';
import { parseMessagesFromContent } from '../src/working-vibes/generate.js';

describe('loadVibesFromFile', () => {
  test('reads non-empty non-comment lines from {theme}.txt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'powerline-vibes-'));
    writeFileSync(
      join(dir, 'pirate.txt'),
      '# comment\nArrr-ing\nPlundering\n\nSwashbuckling\n',
      'utf8',
    );
    const msgs = loadVibesFromFile('pirate', dir);
    expect(msgs).toEqual([
      'Arrr-ing',
      'Plundering',
      'Swashbuckling',
    ]);
  });

  test('returns empty list when file missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'powerline-vibes-'));
    expect(loadVibesFromFile('missing', dir)).toEqual([]);
  });
});

describe('parseMessagesFromContent', () => {
  test('strips numbering, bullets, and long lines', () => {
    const content = [
      '1. Engaging',
      '- Warping',
      '* Scanning',
      'Phasing',
      '',
      '# hint',
      'A very very very very very very very very very long line that should be dropped',
    ].join('\n');
    const msgs = parseMessagesFromContent(content);
    expect(msgs).toEqual([
      'Engaging',
      'Warping',
      'Scanning',
      'Phasing',
    ]);
  });
});
