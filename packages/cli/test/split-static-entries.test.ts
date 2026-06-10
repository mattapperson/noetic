import { describe, expect, test } from 'bun:test';
import { splitStaticEntries } from '../src/tui/grouping/split-static-entries.js';
import type { CollapsedReadGroup, DisplayEntry } from '../src/tui/grouping/types.js';
import type { UserEntry } from '../src/tui/item-utils.js';

function userEntry(id: string, deliveryStatus: 'queued' | 'sent'): UserEntry {
  return {
    role: 'user',
    content: `message ${id}`,
    id,
    deliveryStatus,
  };
}

function readGroup(id: string): CollapsedReadGroup {
  return {
    kind: 'collapsed-read-group',
    id: `group-${id}`,
    readPaths: [
      '/a.ts',
    ],
    listPaths: [],
    searchPatterns: [],
    latestHint: '/a.ts',
  };
}

function assistantMessage(id: string, text: string): DisplayEntry {
  return {
    id,
    type: 'message',
    role: 'assistant',
    status: 'in_progress',
    content: [
      {
        type: 'output_text',
        text,
      },
    ],
  };
}

describe('splitStaticEntries', () => {
  test('queued user entry mid-list splits the prefix there', () => {
    const entries: DisplayEntry[] = [
      userEntry('u1', 'sent'),
      assistantMessage('m1', 'done'),
      userEntry('u2', 'queued'),
      assistantMessage('m2', 'streaming...'),
    ];
    const { staticEntries, liveEntries } = splitStaticEntries(entries, 'streaming');
    expect(staticEntries).toEqual([
      entries[0],
      entries[1],
    ]);
    expect(liveEntries).toEqual([
      entries[2],
      entries[3],
    ]);
  });

  test('trailing read group stays live while streaming, freezes when ready', () => {
    const entries: DisplayEntry[] = [
      userEntry('u1', 'sent'),
      readGroup('c1'),
    ];
    const streaming = splitStaticEntries(entries, 'streaming');
    expect(streaming.staticEntries).toEqual([
      entries[0],
    ]);
    expect(streaming.liveEntries).toEqual([
      entries[1],
    ]);
    // 'submitted' counts as turn-active too — the group can still grow.
    const submitted = splitStaticEntries(entries, 'submitted');
    expect(submitted.liveEntries).toEqual([
      entries[1],
    ]);
    const ready = splitStaticEntries(entries, 'ready');
    expect(ready.staticEntries).toEqual(entries);
    expect(ready.liveEntries).toEqual([]);
  });

  test('all-sent entries while ready are fully static', () => {
    const entries: DisplayEntry[] = [
      userEntry('u1', 'sent'),
      assistantMessage('m1', 'hello'),
      userEntry('u2', 'sent'),
    ];
    const { staticEntries, liveEntries } = splitStaticEntries(entries, 'ready');
    expect(staticEntries).toEqual(entries);
    expect(liveEntries).toEqual([]);
  });

  test('submitted + trailing SENT user entry stays static (old-semantics regression)', () => {
    const entries: DisplayEntry[] = [
      assistantMessage('m1', 'hello'),
      userEntry('u1', 'sent'),
    ];
    const { staticEntries, liveEntries } = splitStaticEntries(entries, 'submitted');
    expect(staticEntries).toEqual(entries);
    expect(liveEntries).toEqual([]);
  });

  test('streaming withholds the trailing non-user entry', () => {
    const entries: DisplayEntry[] = [
      userEntry('u1', 'sent'),
      assistantMessage('m1', 'partial...'),
    ];
    const { staticEntries, liveEntries } = splitStaticEntries(entries, 'streaming');
    expect(staticEntries).toEqual([
      entries[0],
    ]);
    expect(liveEntries).toEqual([
      entries[1],
    ]);
  });

  test('empty input splits into two empty halves', () => {
    const { staticEntries, liveEntries } = splitStaticEntries([], 'streaming');
    expect(staticEntries).toEqual([]);
    expect(liveEntries).toEqual([]);
  });
});
