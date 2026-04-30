/**
 * Coverage for `use-events-tail.ts`. The React hook itself is hard to
 * mount without `ink-testing-library`, so we exhaustively cover the
 * pure helpers that drive its semantics:
 *
 * - `readEventsSize` returns -1 when the file is missing and the file
 *   size when it exists.
 * - `shouldBumpRevision` only fires the first time we observe the file
 *   and on subsequent growth — never on shrinks (which never happen
 *   in practice but are checked defensively).
 *
 * We also drive the hook indirectly via `appendEvent` through the
 * in-memory store and verify a fresh size watermark would be observed.
 */

import { describe, expect, test } from 'bun:test';

import { appendEvent } from '../../../src/commands/builtins/tasks/fs-store.js';
import { taskRootPaths } from '../../../src/commands/builtins/tasks/paths.js';
import {
  readEventsSize,
  shouldBumpRevision,
} from '../../../src/commands/builtins/tasks/ui/use-events-tail.js';
import { makeStoreContext } from '../_helpers.js';

describe('readEventsSize', () => {
  test('returns -1 when _events.jsonl is missing', async () => {
    const ctx = makeStoreContext('/repo-empty');
    const size = await readEventsSize({
      fs: ctx.fs,
      projectRoot: ctx.projectRoot,
    });
    expect(size).toBe(-1);
  });

  test('returns the byte size after an event is appended', async () => {
    const ctx = makeStoreContext('/repo-events');
    await appendEvent(ctx, {
      taskId: 'T-aaaaaaaaaa',
      kind: 'task:created',
      ts: '2026-04-30T00:00:00.000Z',
    });
    const size = await readEventsSize({
      fs: ctx.fs,
      projectRoot: ctx.projectRoot,
    });
    expect(size).toBeGreaterThan(0);
    // Sanity: the size matches the on-disk content length.
    const eventsPath = taskRootPaths(ctx.projectRoot).events;
    const fileText = await ctx.fs.readFileText(eventsPath);
    expect(size).toBe(Buffer.byteLength(fileText, 'utf-8'));
  });
});

describe('shouldBumpRevision', () => {
  test('first observation (-1 → 0) always bumps even for an empty file', () => {
    expect(shouldBumpRevision(-1, 0)).toBe(true);
  });

  test('first observation (-1 → N) bumps for any non-negative N', () => {
    expect(shouldBumpRevision(-1, 100)).toBe(true);
  });

  test('first observation (-1 → -1) does not bump (file still missing)', () => {
    expect(shouldBumpRevision(-1, -1)).toBe(false);
  });

  test('size growth bumps the revision', () => {
    expect(shouldBumpRevision(10, 11)).toBe(true);
    // Boundary: N → N+1 (the smallest possible growth).
    expect(shouldBumpRevision(0, 1)).toBe(true);
  });

  test('boundary: same size never bumps', () => {
    expect(shouldBumpRevision(10, 10)).toBe(false);
  });

  test('boundary: shrinkage never bumps (defends against truncation)', () => {
    expect(shouldBumpRevision(10, 5)).toBe(false);
    // N → N-1 on the boundary.
    expect(shouldBumpRevision(1, 0)).toBe(false);
  });
});

describe('readEventsSize + shouldBumpRevision composition', () => {
  test('appending a row pushes the size watermark forward', async () => {
    const ctx = makeStoreContext('/repo-tail');
    const before = await readEventsSize({
      fs: ctx.fs,
      projectRoot: ctx.projectRoot,
    });
    await appendEvent(ctx, {
      taskId: 'T-bbbbbbbbbb',
      kind: 'log:appended',
      ts: '2026-04-30T01:00:00.000Z',
    });
    const after = await readEventsSize({
      fs: ctx.fs,
      projectRoot: ctx.projectRoot,
    });
    expect(shouldBumpRevision(before, after)).toBe(true);
  });
});
