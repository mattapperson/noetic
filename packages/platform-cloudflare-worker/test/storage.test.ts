// The two Cloudflare storage adapters meet the `StorageAdapter` contract, with
// `swap` as the compare-and-set a turn lease needs. See specs/25-platform-packages
// § Cloudflare Workers and specs/23-durable-execution § One writer per turn.

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import type { StorageAdapter } from '@noetic-tools/core';
import { createD1Storage } from '../src/d1-storage';
import { createDurableObjectStorage } from '../src/durable-object-storage';
import { fakeD1, fakeObjectSql } from './_helpers';

/** Two adapters over the same database, as two Workers, or two requests, would hold. */
type Pair = () => [
  StorageAdapter,
  StorageAdapter,
];

const adapters: Record<string, Pair> = {
  D1: () => {
    const db = new Database(':memory:');
    return [
      createD1Storage({
        database: fakeD1(db),
      }),
      createD1Storage({
        database: fakeD1(db),
      }),
    ];
  },
  'Durable Object SQL': () => {
    const db = new Database(':memory:');
    return [
      createDurableObjectStorage({
        sql: fakeObjectSql(db),
      }),
      createDurableObjectStorage({
        sql: fakeObjectSql(db),
      }),
    ];
  },
};

for (const [name, pair] of Object.entries(adapters)) {
  describe(`${name} storage`, () => {
    it('reads back what it stored, and null for what it did not', async () => {
      const [storage] = pair();
      expect(await storage.get('missing')).toBeNull();
      await storage.set('a', {
        n: 1,
      });
      expect(
        await storage.get<{
          n: number;
        }>('a'),
      ).toEqual({
        n: 1,
      });
      await storage.set('a', {
        n: 2,
      });
      expect(
        await storage.get<{
          n: number;
        }>('a'),
      ).toEqual({
        n: 2,
      });
    });

    it('deletes a key, and deleting a missing one is a no-op', async () => {
      const [storage] = pair();
      await storage.set('a', 1);
      await storage.delete('a');
      await storage.delete('a');
      expect(await storage.get('a')).toBeNull();
    });

    it('lists by literal prefix: % and _ are not wildcards', async () => {
      const [storage] = pair();
      await storage.set('run:1:a', 1);
      await storage.set('run:1:b', 1);
      await storage.set('run:2:a', 1);
      await storage.set('a_b', 1);
      await storage.set('axb', 1);
      expect((await storage.list('run:1:')).sort()).toEqual([
        'run:1:a',
        'run:1:b',
      ]);
      expect(await storage.list('a_')).toEqual([
        'a_b',
      ]);
      expect(await storage.list('%')).toEqual([]);
    });

    it('swap creates only a key that is missing', async () => {
      const [a, b] = pair();
      expect(await a.swap?.('lease', null, 'a')).toBe(true);
      expect(await b.swap?.('lease', null, 'b')).toBe(false);
      expect(await b.get<string>('lease')).toBe('a');
    });

    it('swap replaces only the value it was shown', async () => {
      const [a, b] = pair();
      await a.set('lease', {
        term: 1,
      });
      // Both read term 1; one of them wins the move to term 2.
      const seen: {
        term: number;
        holder?: string;
      } = {
        term: 1,
      };
      expect(
        await a.swap?.('lease', seen, {
          term: 2,
          holder: 'a',
        }),
      ).toBe(true);
      expect(
        await b.swap?.('lease', seen, {
          term: 2,
          holder: 'b',
        }),
      ).toBe(false);
      expect(
        await b.get<{
          holder: string;
        }>('lease'),
      ).toMatchObject({
        holder: 'a',
      });
    });

    it('swap against a value refuses a key that is missing', async () => {
      const [storage] = pair();
      expect(await storage.swap?.('lease', 'old', 'new')).toBe(false);
      expect(await storage.get('lease')).toBeNull();
    });

    it('only one of many racing swaps wins', async () => {
      const [a, b] = pair();
      const tries = await Promise.all(
        Array.from(
          {
            length: 20,
          },
          (_, i) => (i % 2 === 0 ? a : b).swap?.('lease', null, i),
        ),
      );
      expect(tries.filter((won) => won === true)).toHaveLength(1);
    });
  });
}

describe('table names', () => {
  it('each adapter keeps to its own table', async () => {
    const db = new Database(':memory:');
    const first = createD1Storage({
      database: fakeD1(db),
      table: 'one',
    });
    const second = createD1Storage({
      database: fakeD1(db),
      table: 'two',
    });
    await first.set('k', 1);
    expect(await second.get('k')).toBeNull();
  });

  it('refuse anything but a plain identifier', () => {
    expect(() =>
      createD1Storage({
        database: fakeD1(),
        table: 'x; DROP TABLE y',
      }),
    ).toThrow('not a valid table name');
    expect(() =>
      createDurableObjectStorage({
        sql: fakeObjectSql(),
        table: 'has space',
      }),
    ).toThrow('not a valid table name');
  });
});

describe('D1 storage when the database fails', () => {
  it('throws, and makes its table once the database is back', async () => {
    const state = {
      failing: true,
    };
    const storage = createD1Storage({
      database: fakeD1(new Database(':memory:'), state),
    });
    await expect(storage.set('k', 1)).rejects.toThrow('D1_ERROR');
    await expect(storage.swap?.('k', null, 1)).rejects.toThrow('D1_ERROR');
    state.failing = false;
    await storage.set('k', 1);
    expect(await storage.get<number>('k')).toBe(1);
  });
});
