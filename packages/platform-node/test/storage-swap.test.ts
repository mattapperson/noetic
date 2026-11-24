// `StorageAdapter.swap` on the two durable adapters: compare-and-set that two
// adapters over the same files agree on. See specs/23-durable-execution § One
// writer per turn.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { StorageAdapter } from '@noetic-tools/core';
import { createFileStorage } from '../src/file-storage';
import { createSqliteStorage } from '../src/sqlite-storage';

const dirs: string[] = [];
const databases: Database[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'noetic-swap-'));
  dirs.push(dir);
  return dir;
}

function openDatabase(file: string): Database {
  const db = new Database(file);
  databases.push(db);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, {
      recursive: true,
      force: true,
    });
  }
});

/** Two adapters over the same backing store, as two processes would hold. */
type Pair = () => [
  StorageAdapter,
  StorageAdapter,
];

const adapters: Record<string, Pair> = {
  file: () => {
    const root = tempDir();
    return [
      createFileStorage({
        root,
      }),
      createFileStorage({
        root,
      }),
    ];
  },
  sqlite: () => {
    const file = path.join(tempDir(), 'storage.db');
    return [
      createSqliteStorage({
        database: openDatabase(file),
      }),
      createSqliteStorage({
        database: openDatabase(file),
      }),
    ];
  },
};

for (const [name, pair] of Object.entries(adapters)) {
  describe(`${name} storage swap`, () => {
    it('creates a key once: the second creator loses', async () => {
      const [left, right] = pair();
      assert(left.swap && right.swap);
      expect(await left.swap('lease', null, 'left')).toBe(true);
      expect(await right.swap('lease', null, 'right')).toBe(false);
      expect(await right.get<string>('lease')).toBe('left');
    });

    it('replaces only what the caller read', async () => {
      const [left, right] = pair();
      assert(left.swap && right.swap);
      await left.set('lease', {
        term: 1,
        holder: 'left',
      });
      const read = await right.get<{
        term: number;
        holder: string;
      }>('lease');
      assert(read);
      expect(
        await right.swap('lease', read, {
          term: 2,
          holder: 'right',
        }),
      ).toBe(true);
      // `left` still believes term 1 is stored.
      expect(
        await left.swap(
          'lease',
          {
            term: 1,
            holder: 'left',
          },
          {
            term: 2,
            holder: 'left',
          },
        ),
      ).toBe(false);
      expect(
        await left.get<{
          term: number;
          holder: string;
        }>('lease'),
      ).toEqual({
        term: 2,
        holder: 'right',
      });
    });

    it('does not create a key when the caller expected a value', async () => {
      const [left] = pair();
      assert(left.swap);
      expect(await left.swap('absent', 'something', 'next')).toBe(false);
      expect(await left.get<string>('absent')).toBeNull();
    });

    it('of many racing creators, exactly one wins', async () => {
      const [left, right] = pair();
      const swapLeft = left.swap?.bind(left);
      const swapRight = right.swap?.bind(right);
      assert(swapLeft && swapRight);
      const results = await Promise.all(
        Array.from(
          {
            length: 20,
          },
          (_, i) => (i % 2 === 0 ? swapLeft : swapRight)('race', null, i),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });
  });
}

describe('sqlite storage', () => {
  function storage(): StorageAdapter {
    return createSqliteStorage({
      database: openDatabase(':memory:'),
    });
  }

  it('round-trips values and reports a missing key as null', async () => {
    const s = storage();
    await s.set('a', {
      n: 1,
    });
    expect(
      await s.get<{
        n: number;
      }>('a'),
    ).toEqual({
      n: 1,
    });
    expect(await s.get<string>('missing')).toBeNull();
  });

  it('overwrites, deletes, and lists by prefix', async () => {
    const s = storage();
    await s.set('execution:1:ledger:0', 'x');
    await s.set('execution:1:ledger:1', 'y');
    await s.set('execution:10:ledger:0', 'z');
    await s.set('execution:1:ledger:0', 'x2');
    expect(await s.get<string>('execution:1:ledger:0')).toBe('x2');
    expect((await s.list('execution:1:')).sort()).toEqual([
      'execution:1:ledger:0',
      'execution:1:ledger:1',
    ]);
    await s.delete('execution:1:ledger:1');
    expect(await s.list('execution:1:')).toEqual([
      'execution:1:ledger:0',
    ]);
  });

  it('treats % and _ in a prefix literally', async () => {
    const s = storage();
    await s.set('a_b', 1);
    await s.set('axb', 2);
    expect(await s.list('a_')).toEqual([
      'a_b',
    ]);
  });

  it('reads many keys at once, leaving out the missing ones', async () => {
    const s = storage();
    await s.set('a', 1);
    await s.set('b', 2);
    assert(s.getMany);
    const found = await s.getMany<number>([
      'a',
      'missing',
      'b',
    ]);
    expect([
      ...found.entries(),
    ]).toEqual([
      [
        'a',
        1,
      ],
      [
        'b',
        2,
      ],
    ]);
  });

  it('refuses a table name that is not a plain identifier', () => {
    expect(() =>
      createSqliteStorage({
        database: openDatabase(':memory:'),
        table: 'x; DROP TABLE y',
      }),
    ).toThrow('not a valid table name');
  });

  it('throws when a write fails instead of swallowing it', async () => {
    const db = openDatabase(':memory:');
    const s = createSqliteStorage({
      database: db,
    });
    db.exec('DROP TABLE noetic_storage');
    await expect(s.set('a', 1)).rejects.toThrow();
  });
});
