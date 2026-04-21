/**
 * Snapshot persistence for design decks. Each snapshot is a directory
 * `<dataDir>/<slug>-<ISO date>[ -submitted | -cancelled ]/` containing:
 *  - deck.json       — full Deck + selections + metadata
 *  - summary.md      — human-readable Markdown summary of the run
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Deck, DeckSelections } from './types.js';

const MAX_SLUG_LEN = 60;

export type SnapshotStatus = 'submitted' | 'cancelled';

export interface SnapshotRecord {
  version: 1;
  at: string;
  status: SnapshotStatus;
  deck: Deck;
  selections: DeckSelections;
}

interface WriteArgs {
  dataDir: string;
  deck: Deck;
  selections: DeckSelections;
  status: SnapshotStatus;
  now?: Date;
}

export interface WriteResult {
  dir: string;
  jsonPath: string;
  summaryPath: string;
}

export function writeSnapshot(args: WriteArgs): WriteResult {
  const now = args.now ?? new Date();
  const slug = slugify(args.deck.title);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dirName = `${slug}-${stamp}-${args.status}`;
  const dir = join(args.dataDir, dirName);
  mkdirSync(dir, {
    recursive: true,
  });
  const record: SnapshotRecord = {
    version: 1,
    at: now.toISOString(),
    status: args.status,
    deck: args.deck,
    selections: args.selections,
  };
  const jsonPath = join(dir, 'deck.json');
  const summaryPath = join(dir, 'summary.md');
  writeFileSync(jsonPath, JSON.stringify(record, null, 2));
  writeFileSync(summaryPath, buildSummary(record));
  return {
    dir,
    jsonPath,
    summaryPath,
  };
}

export function readSnapshot(jsonPath: string): SnapshotRecord {
  const raw = readFileSync(jsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!isSnapshotRecord(parsed)) {
    throw new Error(`Invalid snapshot at ${jsonPath}`);
  }
  return parsed;
}

export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = cleaned.length > 0 ? cleaned : 'deck';
  return base.slice(0, MAX_SLUG_LEN);
}

function buildSummary(record: SnapshotRecord): string {
  const lines: string[] = [
    `# ${record.deck.title}`,
    '',
    `- Status: **${record.status}**`,
    `- At: ${record.at}`,
    `- Slides: ${record.deck.slides.length}`,
    `- Selections: ${Object.keys(record.selections).length}`,
    '',
    '## Selections',
    '',
  ];
  for (const slide of record.deck.slides) {
    const chosen = record.selections[slide.id];
    lines.push(`- **${slide.title}** — ${chosen ?? '_(none)_'}`);
  }
  return `${lines.join('\n')}\n`;
}

function isSnapshotRecord(value: unknown): value is SnapshotRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (
    !('version' in value) ||
    !('at' in value) ||
    !('status' in value) ||
    !('deck' in value) ||
    !('selections' in value)
  ) {
    return false;
  }
  const status = value.status;
  return (
    value.version === 1 &&
    typeof value.at === 'string' &&
    (status === 'submitted' || status === 'cancelled') &&
    typeof value.deck === 'object' &&
    value.deck !== null &&
    typeof value.selections === 'object' &&
    value.selections !== null
  );
}
