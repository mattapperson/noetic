// A scope keeps one tenant's rows apart from another's in a shared table. See
// specs/25-platform-packages § Scopes.

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { StorageAdapter } from '@noetic-tools/core';
import { createD1Storage } from '../src/d1-storage';
import { createDurableObjectStorage } from '../src/durable-object-storage';
import { fakeD1, fakeObjectSql } from './_helpers';

type Scoped = (db: Database, scope?: string) => StorageAdapter;

const adapters: Record<string, Scoped> = {
  D1: (db, scope) =>
    createD1Storage({
      database: fakeD1(db),
      scope,
    }),
  'Durable Object SQL': (db, scope) =>
    createDurableObjectStorage({
      sql: fakeObjectSql(db),
      scope,
    }),
};

for (const [name, scoped] of Object.entries(adapters)) {
  describe(`${name} storage with a scope`, () => {
    it('keeps two scopes in one table apart, for every operation', async () => {
      const db = new Database(':memory:');
      const alice = scoped(db, 'alice');
      const bob = scoped(db, 'bob');
      await alice.set('session:t', 'hers');
      await bob.set('session:t', 'his');
      await alice.set('session:u', 'only hers');

      expect(await alice.get<string>('session:t')).toBe('hers');
      expect(await bob.get<string>('session:t')).toBe('his');
      expect((await alice.list('session:')).sort()).toEqual([
        'session:t',
        'session:u',
      ]);
      expect(await bob.list('session:')).toEqual([
        'session:t',
      ]);
      assert(alice.getMany && bob.getMany);
      expect(
        await bob.getMany([
          'session:t',
          'session:u',
        ]),
      ).toEqual(
        new Map([
          [
            'session:t',
            'his',
          ],
        ]),
      );

      await bob.delete('session:t');
      expect(await bob.get('session:t')).toBeNull();
      expect(await alice.get<string>('session:t')).toBe('hers');
      // One table, with the scope in its primary key.
      expect(db.query('SELECT scope, key FROM noetic_storage ORDER BY scope, key').all()).toEqual([
        {
          scope: 'alice',
          key: 'session:t',
        },
        {
          scope: 'alice',
          key: 'session:u',
        },
      ]);
    });

    it('swap in one scope neither sees nor wins a key of another', async () => {
      const db = new Database(':memory:');
      const alice = scoped(db, 'alice');
      const bob = scoped(db, 'bob');
      assert(alice.swap && bob.swap);
      await alice.set('lease', 1);

      // The key is missing in bob's scope, so his create wins and hers is untouched.
      expect(await bob.swap('lease', 1, 2)).toBe(false);
      expect(await bob.swap('lease', null, 7)).toBe(true);
      expect(await alice.swap('lease', 1, 2)).toBe(true);
      expect(await alice.get<number>('lease')).toBe(2);
      expect(await bob.get<number>('lease')).toBe(7);
    });

    it('two adapters of one scope share its rows, and only one of their racing swaps wins', async () => {
      const db = new Database(':memory:');
      const first = scoped(db, 'alice');
      const second = scoped(db, 'alice');
      await first.set('k', 0);
      const tries = await Promise.all(
        [
          first,
          second,
          first,
          second,
        ].map((storage, n) => storage.swap?.('k', 0, n + 1)),
      );
      expect(tries.filter((won) => won === true)).toHaveLength(1);
    });

    it('takes any text as a scope: it is bound, never written into a statement', async () => {
      const db = new Database(':memory:');
      const odd = scoped(db, "o'; DROP TABLE noetic_storage; --");
      await odd.set('k', 1);
      expect(await odd.get<number>('k')).toBe(1);
      expect(await scoped(db, 'other').get('k')).toBeNull();
    });

    it('refuses an empty scope', () => {
      expect(() => scoped(new Database(':memory:'), '')).toThrow('scope must not be empty');
    });

    it('getMany reads more keys than one statement binds, and leaves missing ones out', async () => {
      const storage = scoped(new Database(':memory:'), 'alice');
      const keys = Array.from(
        {
          length: 200,
        },
        (_, n) => `k${n}`,
      );
      await Promise.all(keys.map((key, n) => storage.set(key, n)));
      assert(storage.getMany);
      const found = await storage.getMany([
        ...keys,
        'k0',
        'missing',
      ]);
      expect(found.size).toBe(200);
      expect(found.get('k199')).toBe(199);
      expect(found.has('missing')).toBe(false);
    });
  });

  describe(`${name} storage without a scope`, () => {
    it('keeps the two-column table, and getMany reads it', async () => {
      const db = new Database(':memory:');
      const storage = scoped(db);
      await storage.set('a', 1);
      await storage.set('b', 2);
      expect(db.query('SELECT * FROM noetic_storage ORDER BY key').all()).toEqual([
        {
          key: 'a',
          value: '1',
        },
        {
          key: 'b',
          value: '2',
        },
      ]);
      assert(storage.getMany);
      expect(
        await storage.getMany([
          'a',
          'b',
          'c',
        ]),
      ).toEqual(
        new Map([
          [
            'a',
            1,
          ],
          [
            'b',
            2,
          ],
        ]),
      );
      expect(await storage.getMany([])).toEqual(new Map());
    });
  });
}

describe('a table made without a scope', () => {
  it('fails a scoped adapter on its first statement', async () => {
    const db = new Database(':memory:');
    await createD1Storage({
      database: fakeD1(db),
    }).set('k', 1);
    const scoped = createD1Storage({
      database: fakeD1(db),
      scope: 'alice',
    });
    await expect(scoped.get('k')).rejects.toThrow('scope');
  });
});

describe('a table made with a scope', () => {
  for (const [name, scoped] of Object.entries(adapters)) {
    it(`fails a ${name} adapter without a scope before it reads any scope's rows`, async () => {
      const db = new Database(':memory:');
      await scoped(db, 'alice').set('k', 'A');
      await scoped(db, 'bob').set('k', 'B');
      // The Durable Object adapter checks when it is made; D1's on its first call.
      const attempt = async (): Promise<unknown> => scoped(db).get('k');
      await expect(attempt()).rejects.toThrow('Give this adapter a scope');
      expect(await scoped(db, 'alice').get('k')).toBe('A');
      expect(await scoped(db, 'bob').get('k')).toBe('B');
    });
  }
});
