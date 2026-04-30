import { describe, expect, test } from 'bun:test';
import { collapseReads } from '../src/tui/grouping/collapse-reads.js';
import type { CollapsedReadGroup } from '../src/tui/grouping/types.js';
import { isCollapsedReadGroup } from '../src/tui/grouping/types.js';
import type { ConversationEntry } from '../src/tui/item-utils.js';
import { isErrorEntry, isSystemEntry, isUserEntry } from '../src/tui/item-utils.js';

//#region Helpers

type FunctionCallStatus = 'in_progress' | 'incomplete' | 'completed';

function callEntry(
  name: string,
  args: Record<string, unknown>,
  status: FunctionCallStatus = 'completed',
): ConversationEntry {
  return {
    id: `call-${name}-${JSON.stringify(args)}`,
    type: 'function_call',
    callId: `cid-${name}-${JSON.stringify(args)}`,
    name,
    arguments: JSON.stringify(args),
    status,
  };
}

function callOutput(callId: string, output: string): ConversationEntry {
  return {
    id: `out-${callId}`,
    type: 'function_call_output',
    status: 'completed',
    callId,
    output,
  };
}

function message(text: string): ConversationEntry {
  return {
    id: `msg-${text}`,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [
      {
        type: 'output_text',
        text,
      },
    ],
  };
}

function firstGroup(displays: ReturnType<typeof collapseReads>): CollapsedReadGroup {
  const group = displays.find(isCollapsedReadGroup);
  if (!group) {
    throw new Error('no CollapsedReadGroup emitted');
  }
  return group;
}

//#endregion

describe('collapseReads', () => {
  test('collapses three consecutive Reads with de-duped paths', () => {
    const entries: ConversationEntry[] = [
      callEntry('Read', {
        path: '/a.ts',
      }),
      callOutput('cid-Read-{"path":"/a.ts"}', '...'),
      callEntry('Read', {
        path: '/b.ts',
      }),
      callOutput('cid-Read-{"path":"/b.ts"}', '...'),
      callEntry('Read', {
        path: '/a.ts',
      }),
      callOutput('cid-Read-{"path":"/a.ts"}', '...'),
    ];
    const out = collapseReads(entries);
    expect(out.length).toBe(1);
    const group = firstGroup(out);
    expect(group.readPaths.length).toBe(2);
    expect(group.listPaths.length).toBe(0);
    expect(group.searchPatterns.length).toBe(0);
  });

  test('mixes Reads and Ls in a single group', () => {
    const entries: ConversationEntry[] = [
      callEntry('Read', {
        path: '/a.ts',
      }),
      callOutput('cid-Read-{"path":"/a.ts"}', '...'),
      callEntry('Read', {
        path: '/b.ts',
      }),
      callOutput('cid-Read-{"path":"/b.ts"}', '...'),
      callEntry('Ls', {
        path: '/src',
      }),
      callOutput('cid-Ls-{"path":"/src"}', '...'),
    ];
    const out = collapseReads(entries);
    expect(out.length).toBe(1);
    const group = firstGroup(out);
    expect(group.readPaths.length).toBe(2);
    expect(group.listPaths.length).toBe(1);
    expect(group.latestHint).toBe('/src');
  });

  test('folds Find and Grep into searchPatterns', () => {
    const entries: ConversationEntry[] = [
      callEntry('Find', {
        pattern: '*.ts',
      }),
      callOutput('cid-Find-{"pattern":"*.ts"}', ''),
      callEntry('Grep', {
        pattern: 'TODO',
      }),
      callOutput('cid-Grep-{"pattern":"TODO"}', ''),
    ];
    const out = collapseReads(entries);
    expect(out.length).toBe(1);
    const group = firstGroup(out);
    expect(group.readPaths.length).toBe(0);
    expect(group.searchPatterns).toEqual([
      '*.ts',
      'TODO',
    ]);
  });

  test('singleton Read still emits a group (handled by renderer)', () => {
    const entries: ConversationEntry[] = [
      callEntry('Read', {
        path: '/a.ts',
      }),
      callOutput('cid-Read-{"path":"/a.ts"}', '...'),
    ];
    const out = collapseReads(entries);
    expect(out.length).toBe(1);
    const group = firstGroup(out);
    expect(group.readPaths).toEqual([
      '/a.ts',
    ]);
  });

  test('breaks group on assistant message', () => {
    const entries: ConversationEntry[] = [
      callEntry('Read', {
        path: '/a.ts',
      }),
      callOutput('cid-Read-{"path":"/a.ts"}', '...'),
      message('about to read another'),
      callEntry('Read', {
        path: '/b.ts',
      }),
      callOutput('cid-Read-{"path":"/b.ts"}', '...'),
    ];
    const out = collapseReads(entries);
    const groups = out.filter(isCollapsedReadGroup);
    expect(groups.length).toBe(2);
    expect(groups[0]?.readPaths).toEqual([
      '/a.ts',
    ]);
    expect(groups[1]?.readPaths).toEqual([
      '/b.ts',
    ]);
  });

  test('breaks group on non-collapsible tool call', () => {
    const entries: ConversationEntry[] = [
      callEntry('Read', {
        path: '/a.ts',
      }),
      callOutput('cid-Read-{"path":"/a.ts"}', '...'),
      callEntry('Edit', {
        path: '/a.ts',
      }),
      callOutput('cid-Edit-{"path":"/a.ts"}', '{}'),
      callEntry('Read', {
        path: '/b.ts',
      }),
      callOutput('cid-Read-{"path":"/b.ts"}', '...'),
    ];
    const out = collapseReads(entries);
    const groups = out.filter(isCollapsedReadGroup);
    expect(groups.length).toBe(2);
    // Edit call and its output pass through untouched
    expect(
      out.some(
        (e) =>
          !isCollapsedReadGroup(e) &&
          !isUserEntry(e) &&
          !isErrorEntry(e) &&
          !isSystemEntry(e) &&
          e.type === 'function_call',
      ),
    ).toBe(true);
    expect(
      out.some(
        (e) =>
          !isCollapsedReadGroup(e) &&
          !isUserEntry(e) &&
          !isErrorEntry(e) &&
          !isSystemEntry(e) &&
          e.type === 'function_call_output',
      ),
    ).toBe(true);
  });

  test('passes through output whose call was not absorbed', () => {
    const entries: ConversationEntry[] = [
      callOutput('unknown-call', 'stray'),
    ];
    const out = collapseReads(entries);
    expect(out.length).toBe(1);
    expect(isCollapsedReadGroup(out[0]!)).toBe(false);
  });

  test('empty input yields empty output', () => {
    expect(collapseReads([])).toEqual([]);
  });

  test('Ls without explicit path defaults to "."', () => {
    const entries: ConversationEntry[] = [
      callEntry('Ls', {}),
      callOutput('cid-Ls-{}', ''),
    ];
    const out = collapseReads(entries);
    const group = firstGroup(out);
    expect(group.listPaths).toEqual([
      '.',
    ]);
  });

  test('invalid arguments JSON does not crash; just no path/pattern recorded', () => {
    const entries: ConversationEntry[] = [
      {
        id: 'broken',
        type: 'function_call',
        callId: 'cid-broken',
        name: 'Read',
        arguments: 'not-json',
        status: 'completed',
      },
    ];
    const out = collapseReads(entries);
    const group = firstGroup(out);
    expect(group.readPaths.length).toBe(0);
    expect(group.listPaths.length).toBe(0);
  });
});
