// Values too large for a row go to a blob store, and the row keeps a pointer. See
// specs/25-platform-packages § Values larger than a row.

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData, StorageAdapter } from '@noetic-tools/core';
import { AgentHarness, callModel, createInMemoryStorage } from '@noetic-tools/core';
import { createD1Storage } from '../src/d1-storage';
import { createDurableObjectStorage } from '../src/durable-object-storage';
import { DEFAULT_SPILL_BYTES, spillStorage } from '../src/spill-storage';
import type { FakeBlobs } from './_helpers';
import { fakeBlobs, fakeD1, fakeObjectSql, model } from './_helpers';

//#region Fixtures

/** Over this many bytes of JSON, a value is spilled. */
const LIMIT = 64;

/** What these tests store: one shape, so a swap from a small value to a large one type-checks. */
type Stored = Record<string, string>;

const SMALL: Stored = {
  note: 'fits in a row',
};

/** A value whose JSON is well over `LIMIT`, different for each `tag`. */
function big(tag: string): Stored {
  return {
    tag,
    body: 'x'.repeat(4 * LIMIT),
  };
}

interface Made {
  storage: StorageAdapter;
  /** Another adapter over the same rows and objects, as a second Worker holds. */
  other: StorageAdapter;
  blobs: FakeBlobs;
  /** The stored row of `key`, as text. */
  row: (key: string) => string | undefined;
}

type Make = (opts?: { scope?: string; maxBytes?: number }) => Made;

function rowReader(db: Database): Made['row'] {
  return (key) => {
    const found = db.query('SELECT value FROM noetic_storage WHERE key = ?').get(key);
    return typeof found === 'object' && found !== null && 'value' in found
      ? String(found.value)
      : undefined;
  };
}

const adapters: Record<string, Make> = {
  D1: (opts) => {
    const db = new Database(':memory:');
    const blobs = fakeBlobs();
    const make = (): StorageAdapter =>
      createD1Storage({
        database: fakeD1(db),
        scope: opts?.scope,
        spill: {
          blobs,
          maxBytes: opts?.maxBytes ?? LIMIT,
        },
      });
    return {
      storage: make(),
      other: make(),
      blobs,
      row: rowReader(db),
    };
  },
  'Durable Object SQL': (opts) => {
    const db = new Database(':memory:');
    const blobs = fakeBlobs();
    const make = (): StorageAdapter =>
      createDurableObjectStorage({
        sql: fakeObjectSql(db),
        scope: opts?.scope,
        spill: {
          blobs,
          maxBytes: opts?.maxBytes ?? LIMIT,
        },
      });
    return {
      storage: make(),
      other: make(),
      blobs,
      row: rowReader(db),
    };
  },
};

/** The one object a store holds, or a failed assertion. */
function onlyObject(blobs: FakeBlobs): [
  string,
  string,
] {
  expect(blobs.objects.size).toBe(1);
  const [entry] = blobs.objects;
  assert(entry);
  return entry;
}

//#endregion

for (const [name, make] of Object.entries(adapters)) {
  describe(`${name} storage that spills`, () => {
    it('keeps a small value in its row, and makes no object', async () => {
      const { storage, blobs, row } = make();
      await storage.set('k', SMALL);
      expect(await storage.get('k')).toEqual(SMALL);
      expect(row('k')).toBe(JSON.stringify(SMALL));
      expect(blobs.objects.size).toBe(0);
    });

    it('writes a large value to an object, and the row points at it', async () => {
      const { storage, other, blobs, row } = make();
      await storage.set('session:t', big('a'));

      const [object, text] = onlyObject(blobs);
      expect(text).toBe(JSON.stringify(big('a')));
      expect(object).toStartWith('noetic-storage/session:t/');
      expect(row('session:t')).toBe(
        JSON.stringify({
          'noetic:spilled': object,
        }),
      );
      // Any adapter over the same rows and objects reads the value, not the pointer.
      expect(await other.get('session:t')).toEqual(big('a'));
      assert(other.getMany);
      expect(
        await other.getMany([
          'session:t',
          'missing',
        ]),
      ).toEqual(
        new Map([
          [
            'session:t',
            big('a'),
          ],
        ]),
      );
    });

    it('spills at the limit plus one byte, counted in UTF-8', async () => {
      const { storage, blobs } = make({
        maxBytes: 10,
      });
      // Eight characters and two quotes: ten bytes.
      await storage.set('ascii', 'abcdefgh');
      expect(blobs.objects.size).toBe(0);
      await storage.set('ascii', 'abcdefghi');
      expect(blobs.objects.size).toBe(1);
      await storage.delete('ascii');
      // Four characters of three bytes each and two quotes: fourteen bytes, six characters.
      await storage.set('wide', '日本語字');
      expect(blobs.objects.size).toBe(1);
    });

    it('puts a scope in the object key, so two scopes share neither rows nor objects', async () => {
      const { storage, blobs } = make({
        scope: 'alice',
      });
      await storage.set('k', big('a'));
      expect(onlyObject(blobs)[0]).toStartWith('noetic-storage/alice/k/');
    });

    it('deletes the object a write replaces, and the one a delete leaves behind', async () => {
      const { storage, blobs } = make();
      await storage.set('k', big('a'));
      const [first] = onlyObject(blobs);

      await storage.set('k', big('b'));
      const [second, text] = onlyObject(blobs);
      expect(second).not.toBe(first);
      expect(text).toBe(JSON.stringify(big('b')));

      await storage.set('k', SMALL);
      expect(blobs.objects.size).toBe(0);
      expect(await storage.get('k')).toEqual(SMALL);

      await storage.set('k', big('c'));
      await storage.delete('k');
      expect(blobs.objects.size).toBe(0);
      expect(await storage.get('k')).toBeNull();
    });

    it('swap replaces a spilled value only when shown that value', async () => {
      const { storage, other, blobs } = make();
      assert(storage.swap && other.swap);
      expect(await storage.swap('k', null, big('a'))).toBe(true);
      expect(await storage.swap('k', null, big('z'))).toBe(false);

      // Shown another large value, or a small one: refused, and nothing is left behind.
      expect(await other.swap('k', big('not it'), big('b'))).toBe(false);
      expect(await other.swap('k', SMALL, big('b'))).toBe(false);
      expect(onlyObject(blobs)[1]).toBe(JSON.stringify(big('a')));

      expect(await other.swap('k', big('a'), big('b'))).toBe(true);
      expect(await storage.get('k')).toEqual(big('b'));
      expect(onlyObject(blobs)[1]).toBe(JSON.stringify(big('b')));

      // Down to a small value and up again.
      expect(await storage.swap('k', big('b'), SMALL)).toBe(true);
      expect(blobs.objects.size).toBe(0);
      expect(await storage.swap('k', SMALL, big('c'))).toBe(true);
      expect(await other.get('k')).toEqual(big('c'));
      expect(blobs.objects.size).toBe(1);
    });

    it('swap against a spilled value refuses a key that is missing', async () => {
      const { storage, blobs } = make();
      expect(await storage.swap?.('k', big('a'), big('b'))).toBe(false);
      expect(blobs.objects.size).toBe(0);
    });

    it('only one of many racing swaps on a spilled value wins, and one object is left', async () => {
      const { storage, other, blobs } = make();
      await storage.set('k', big('start'));
      const tries = await Promise.all(
        [
          storage,
          other,
          storage,
          other,
          storage,
        ].map((adapter, n) => adapter.swap?.('k', big('start'), big(`winner-${n}`))),
      );
      expect(tries.filter((won) => won === true)).toHaveLength(1);
      const winner = tries.indexOf(true);
      expect(await storage.get('k')).toEqual(big(`winner-${winner}`));
      expect(onlyObject(blobs)[1]).toBe(JSON.stringify(big(`winner-${winner}`)));
    });

    it('fails a write whose object cannot be stored, and leaves the key as it was', async () => {
      const { storage, blobs } = make();
      await storage.set('k', SMALL);
      blobs.failing = true;
      await expect(storage.set('k', big('a'))).rejects.toThrow('R2_ERROR');
      await expect(storage.swap?.('k', SMALL, big('a'))).rejects.toThrow('R2_ERROR');
      expect(await storage.get('k')).toEqual(SMALL);
    });

    it('throws for a pointer whose object is gone, and does not call the key missing', async () => {
      const { storage, blobs } = make();
      await storage.set('k', big('a'));
      blobs.objects.clear();
      await expect(storage.get('k')).rejects.toThrow('points at a missing object');
      await expect(
        storage.getMany?.([
          'k',
        ]),
      ).rejects.toThrow('points at a missing object');
    });

    it('reads again when a writer replaced the value between the row and the object', async () => {
      const { storage, other, blobs } = make();
      await storage.set('k', big('old'));
      const get = blobs.get.bind(blobs);
      let raced = false;
      blobs.get = async (key) => {
        if (!raced) {
          raced = true;
          await other.set('k', big('new'));
        }
        return get(key);
      };
      expect(await storage.get('k')).toEqual(big('new'));
    });

    it('reads a key as missing when it was deleted between the row and the object', async () => {
      const { storage, other, blobs } = make();
      await storage.set('k', big('old'));
      const get = blobs.get.bind(blobs);
      let raced = false;
      blobs.get = async (key) => {
        if (!raced) {
          raced = true;
          await other.delete('k');
        }
        return get(key);
      };
      expect(await storage.get('k')).toBeNull();
    });
  });
}

describe('changing maxBytes', () => {
  it('still reads and swaps a value spilled under a smaller limit', async () => {
    const db = new Database(':memory:');
    const blobs = fakeBlobs();
    const under = (maxBytes: number): StorageAdapter =>
      createD1Storage({
        database: fakeD1(db),
        spill: {
          blobs,
          maxBytes,
        },
      });
    await under(LIMIT).set('k', big('a'));
    expect(blobs.objects.size).toBe(1);

    const raised = under(1e6);
    expect(await raised.get('k')).toEqual(big('a'));
    expect(await raised.swap?.('k', big('a'), big('b'))).toBe(true);
    // Under the larger limit the new value fits its row, and the old object is gone.
    expect(blobs.objects.size).toBe(0);
    expect(await raised.get('k')).toEqual(big('b'));
  });

  it('still swaps a value kept in its row under a larger limit', async () => {
    const db = new Database(':memory:');
    const blobs = fakeBlobs();
    const under = (maxBytes: number): StorageAdapter =>
      createD1Storage({
        database: fakeD1(db),
        spill: {
          blobs,
          maxBytes,
        },
      });
    await under(1e6).set('k', big('a'));
    expect(blobs.objects.size).toBe(0);

    const lowered = under(LIMIT);
    expect(await lowered.swap?.('k', big('a'), big('b'))).toBe(true);
    expect(await lowered.get('k')).toEqual(big('b'));
    expect(blobs.objects.size).toBe(1);
  });
});

describe('spillStorage over any StorageAdapter', () => {
  it('adds spilling to core’s in-memory storage', async () => {
    const blobs = fakeBlobs();
    const inner = createInMemoryStorage({
      swap: true,
    });
    const storage = spillStorage(inner, {
      blobs,
      maxBytes: LIMIT,
      prefix: 'threads',
    });
    await storage.set('k', big('a'));
    expect(onlyObject(blobs)[0]).toStartWith('threads/k/');
    expect(await storage.swap?.('k', big('a'), big('b'))).toBe(true);
    expect(await storage.get('k')).toEqual(big('b'));
    expect(await storage.list('')).toEqual([
      'k',
    ]);
  });

  it('has no swap over a storage that has none', () => {
    const storage = spillStorage(createInMemoryStorage(), {
      blobs: fakeBlobs(),
    });
    expect(storage.swap).toBeUndefined();
  });

  it('cuts a long key in the object key', async () => {
    const blobs = fakeBlobs();
    const storage = spillStorage(createInMemoryStorage(), {
      blobs,
      maxBytes: LIMIT,
    });
    const key = 'k'.repeat(500);
    await storage.set(key, big('a'));
    expect(onlyObject(blobs)[0]).toHaveLength('noetic-storage/'.length + 200 + 1 + 36);
  });

  it('deletes the object of a write the storage refused', async () => {
    const blobs = fakeBlobs();
    const inner = createInMemoryStorage({
      swap: true,
    });
    const storage = spillStorage(
      {
        ...inner,
        get: (key) => inner.get(key),
        set: async () => {
          throw new Error('row too large');
        },
        swap: async () => {
          throw new Error('row too large');
        },
      },
      {
        blobs,
        maxBytes: LIMIT,
      },
    );
    await expect(storage.set('k', big('a'))).rejects.toThrow('row too large');
    await expect(storage.swap?.('k', null, big('a'))).rejects.toThrow('row too large');
    expect(blobs.objects.size).toBe(0);
  });

  it('reports a swap that landed and then threw as won, and keeps its object', async () => {
    const blobs = fakeBlobs();
    const inner = createInMemoryStorage({
      swap: true,
    });
    const storage = spillStorage(
      {
        ...inner,
        get: (key) => inner.get(key),
        swap: async (key, prev, next) => {
          await inner.swap?.(key, prev, next);
          throw new Error('connection lost');
        },
      },
      {
        blobs,
        maxBytes: LIMIT,
      },
    );
    expect(await storage.swap?.('lease', null, big('mine'))).toBe(true);
    expect(await storage.get('lease')).toEqual(big('mine'));
    expect(blobs.objects.size).toBe(1);
  });

  it('refuses a maxBytes that is not a positive number', () => {
    for (const maxBytes of [
      0,
      -1,
      Number.NaN,
    ]) {
      expect(() =>
        spillStorage(createInMemoryStorage(), {
          blobs: fakeBlobs(),
          maxBytes,
        }),
      ).toThrow('maxBytes must be a positive number');
    }
    expect(DEFAULT_SPILL_BYTES).toBe(1048576);
  });
});

describe('a harness on storage that spills', () => {
  it('keeps a thread whose record outgrows a row, across turns and harnesses', async () => {
    const db = new Database(':memory:');
    const blobs = fakeBlobs();
    const answers = model('reply');
    const harness = (): AgentHarness =>
      new AgentHarness({
        name: 'long-thread',
        params: {},
        agentGraph: callModel<ContextData, string, string>({
          id: 'turn',
          model: 'test/model',
        }),
        _testCallModel: answers.call,
        environment: {
          storage: {
            adapter: createD1Storage({
              database: fakeD1(db),
              scope: 'alice',
              spill: {
                blobs,
                // Far under one turn's record, so every write of it spills.
                maxBytes: 256,
              },
            }),
          },
        },
      });
    const thread = {
      threadId: 't',
    };
    const first = harness();
    await first.execute('a long message '.repeat(40), thread);
    expect((await first.getAgentResponse(thread)).text).toBe('reply-1');
    await first.close();
    expect(blobs.objects.size).toBeGreaterThan(0);

    // A new harness reads the spilled record and goes on from it.
    const second = harness();
    await second.execute('and another', thread);
    const response = await second.getAgentResponse(thread);
    expect(response.text).toBe('reply-2');
    await second.close();
    // No row holds more than a pointer or a small value.
    const longest = db.query('SELECT max(length(value)) AS n FROM noetic_storage').get();
    assert(typeof longest === 'object' && longest !== null && 'n' in longest);
    expect(Number(longest.n)).toBeLessThanOrEqual(256);
  });
});
