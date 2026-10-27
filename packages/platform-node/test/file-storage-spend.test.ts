/**
 * A paid-call record torn on disk still reads as pending spend: the file store reads a
 * value it cannot parse as nothing, but its key still lists (spec 23 § Paid dispatches).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentHarness } from '@noetic-tools/core';
import { createFileStorage } from '../src/file-storage';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'noetic-file-spend-'));
});

afterEach(() => {
  rmSync(root, {
    recursive: true,
    force: true,
  });
});

describe('a torn dispatch record on disk', () => {
  it('stays pending until written off', async () => {
    const storage = createFileStorage({
      root,
    });
    // `spend:empty` and `spend:half`, as createFileStorage names them.
    writeFileSync(path.join(root, 'spend__3Aempty.json'), '');
    writeFileSync(path.join(root, 'spend__3Ahalf.json'), '{"id":"half","kind":"mo');
    const harness = new AgentHarness({
      name: 'spend',
      params: {},
      environment: {
        storage: {
          adapter: storage,
        },
      },
    });

    const pending = await harness.pendingSpend();

    expect(pending.map((p) => p.id).sort()).toEqual([
      'empty',
      'half',
    ]);
    expect(pending.every((p) => p.unreadable)).toBe(true);
    expect(
      await harness.writeOffSpend('half', {
        assumedCost: 0.1,
      }),
    ).toMatchObject({
      id: 'half',
      cost: 0.1,
      writtenOff: true,
    });
    expect((await harness.pendingSpend()).map((p) => p.id)).toEqual([
      'empty',
    ]);
  });
});
