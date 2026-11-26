// Values too large for a row go to a blob store, and the row keeps a pointer. See
// specs/25-platform-packages § Values larger than a row.

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import type { ContextData, StorageAdapter, WorkflowDocument } from '@noetic-tools/core';
import { AgentHarness, callModel, createInMemoryStorage, workflow } from '@noetic-tools/core';
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
  db: Database;
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
      db,
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
      db,
      other: make(),
      blobs,
      row: rowReader(db),
    };
  },
};

describe('D1 inline JSON', () => {
  it('replaces and deletes values beyond the SQLite JSON nesting limit', async () => {
    const make = adapters.D1;
    assert(make);
    const { storage, blobs, db } = make({
      scope: 'tenant',
      maxBytes: 10_000,
    });
    let deep: number | unknown[] = 0;
    for (let level = 0; level < 1_100; level += 1) {
      deep = [
        deep,
      ];
    }
    await storage.set('replace', deep);
    await storage.set('delete', deep);
    expect(blobs.objects.size).toBe(0);

    await storage.set('replace', SMALL);
    await storage.delete('delete');
    expect(await storage.get('replace')).toEqual(SMALL);
    expect(await storage.get('delete')).toBeNull();
    expect(db.query('SELECT count(*) AS n FROM noetic_storage').get()).toEqual({
      n: 1,
    });
  });
});

describe('D1 statement preparation', () => {
  for (const operation of [
    'set',
    'delete',
  ] as const) {
    it(`creates the table before preparing the first ${operation}`, async () => {
      const db = new Database(':memory:');
      const binding = fakeD1(db);
      const blobs = fakeBlobs();
      const storage = createD1Storage({
        database: {
          ...binding,
          prepare(query) {
            db.query(query);
            return binding.prepare(query);
          },
        },
        spill: {
          blobs,
          maxBytes: LIMIT,
        },
      });

      if (operation === 'set') {
        await storage.set('first', big('first'));
        expect(await storage.get('first')).toEqual(big('first'));
      } else {
        await storage.delete('missing');
        expect(await storage.get('missing')).toBeNull();
      }
    });
  }
});

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

    it('keeps malformed rows intact when a set or delete fails', async () => {
      const { storage, db, blobs, row } = make();
      await storage.set('seed', SMALL);
      // SQLite accepts this as JSON5, but stored rows must be valid JSON.
      const malformed = '{unquoted: 1}';
      db.query('INSERT INTO noetic_storage (key, value) VALUES (?, ?)').run('bad', malformed);

      await expect(storage.set('bad', big('replacement'))).rejects.toThrow();
      expect(row('bad')).toBe(malformed);
      expect(blobs.objects.size).toBe(0);

      await expect(storage.delete('bad')).rejects.toThrow();
      expect(row('bad')).toBe(malformed);
    });

    it('removes every displaced spill during overlapping writes and deletes', async () => {
      const { storage, other, blobs } = make();
      await storage.set('k', big('old'));
      await Promise.all([
        storage.set('k', big('first')),
        other.set('k', big('second')),
      ]);
      expect(JSON.parse(onlyObject(blobs)[1])).toEqual(await storage.get('k'));

      await Promise.all([
        other.set('k', big('third')),
        storage.delete('k'),
      ]);
      const remaining = await storage.get('k');
      if (remaining === null) {
        expect(blobs.objects.size).toBe(0);
      } else {
        expect(JSON.parse(onlyObject(blobs)[1])).toEqual(remaining);
      }
    });

    it('spills when an inline value and its key exceed the SQL row budget', async () => {
      const { storage, blobs } = make({
        maxBytes: 4_000_000,
        scope: 'tenant',
      });
      const key = '日本語'.repeat(10);
      const value = 'x'.repeat(1_999_950);
      await storage.set(key, value);
      expect(onlyObject(blobs)[1]).toBe(JSON.stringify(value));
      expect(await storage.get(key)).toBe(value);
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

  it('cuts a long key in the object key, by UTF-8 bytes', async () => {
    const blobs = fakeBlobs();
    const storage = spillStorage(createInMemoryStorage(), {
      blobs,
      maxBytes: LIMIT,
    });
    await storage.set('é'.repeat(500), big('a'));
    const [object] = onlyObject(blobs);
    assert(object);
    expect(new TextEncoder().encode(object).byteLength).toBe(
      'noetic-storage/'.length + 200 + 1 + 36,
    );
  });

  it('refuses a prefix that leaves no room for an object key', () => {
    expect(() =>
      spillStorage(createInMemoryStorage(), {
        blobs: fakeBlobs(),
        prefix: 'p'.repeat(1000),
      }),
    ).toThrow('leaves no room');
  });

  it('keeps the object of a write that landed when the row cannot be read to tell', async () => {
    const blobs = fakeBlobs();
    const inner = createInMemoryStorage();
    const outage = {
      on: false,
    };
    const storage = spillStorage(
      {
        ...inner,
        get: async (key) => {
          if (outage.on) {
            throw new Error('D1_ERROR: network');
          }
          return inner.get(key);
        },
        set: async (key, value) => {
          await inner.set(key, value);
          outage.on = true;
          throw new Error('D1_ERROR: network');
        },
      },
      {
        blobs,
        maxBytes: LIMIT,
      },
    );
    await expect(storage.set('k', big('a'))).rejects.toThrow('network');
    outage.on = false;
    expect(await storage.get('k')).toEqual(big('a'));
  });

  it('reports a won swap as won when the replaced object cannot be deleted', async () => {
    const blobs = fakeBlobs();
    const storage = spillStorage(
      createInMemoryStorage({
        swap: true,
      }),
      {
        blobs,
        maxBytes: LIMIT,
      },
    );
    await storage.set('lease', big('old'));
    blobs.delete = async () => {
      throw new Error('R2_ERROR');
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(await storage.swap?.('lease', big('old'), big('new'))).toBe(true);
      await storage.set('lease', SMALL);
      await storage.delete('lease');
    } finally {
      console.warn = warn;
    }
    expect(await storage.get('lease')).toBeNull();
  });

  it('refuses a value shaped like a pointer, and follows no pointer outside its prefix', async () => {
    const blobs = fakeBlobs();
    blobs.objects.set('uploads/other/secret.json', '"secret"');
    const inner = createInMemoryStorage();
    const storage = spillStorage(inner, {
      blobs,
      maxBytes: LIMIT,
    });
    const forged = {
      'noetic:spilled': 'uploads/other/secret.json',
    };
    await expect(storage.set('k', forged)).rejects.toThrow('read as a pointer');

    // A row written some other way is a plain value, and its object is left alone.
    await inner.set('k', forged);
    expect(await storage.get('k')).toEqual(forged);
    await storage.set('k', SMALL);
    await storage.delete('k');
    expect(blobs.objects.get('uploads/other/secret.json')).toBe('"secret"');
  });

  it('follows pointers under movedPrefixes, for rows moved from another layout', async () => {
    const blobs = fakeBlobs();
    blobs.objects.set('r2:thread-1', JSON.stringify(big('moved')));
    const inner = createInMemoryStorage();
    await inner.set('thread', {
      'noetic:spilled': 'r2:thread-1',
    });
    const storage = spillStorage(inner, {
      blobs,
      maxBytes: LIMIT,
      movedPrefixes: [
        'r2:',
      ],
    });
    expect(await storage.get('thread')).toEqual(big('moved'));
    await storage.set('thread', SMALL);
    expect(blobs.objects.has('r2:thread-1')).toBe(false);
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

  it('stores a turn’s workflow document larger than a row, and resumes on it', async () => {
    const db = new Database(':memory:');
    const blobs = fakeBlobs();
    // A document of a few megabytes: far over a row, and over the default spill size.
    const SIZE = 3 * DEFAULT_SPILL_BYTES;
    const document = (prompt: string): WorkflowDocument => ({
      version: 1,
      root: {
        kind: 'callModel',
        id: 'answer',
        model: 'test/model',
        instructions: prompt.padEnd(SIZE, '.'),
      },
    });
    const seen: number[] = [];
    const harness = (prompt: string, fails: boolean): AgentHarness =>
      new AgentHarness({
        name: 'big-flow',
        params: {},
        agentGraph: workflow({
          id: 'flow',
          document: document(prompt),
        }),
        _testCallModel: async (request) => {
          seen.push(request.instructions?.startsWith('old') ? 1 : 2);
          if (fails) {
            throw new Error('fetch failed: ECONNRESET');
          }
          return answers.call(request);
        },
        environment: {
          storage: {
            adapter: createD1Storage({
              database: fakeD1(db),
              scope: 'alice',
              spill: {
                blobs,
              },
            }),
          },
        },
      });
    const answers = model('reply');
    const delivery = {
      threadId: 't',
      messageId: 'm-1',
    };
    const first = harness('old', true);
    await first.execute('hello', delivery);
    await first.getAgentResponse(delivery).catch(() => {});
    await first.close();
    // The turn's one copy of the document went to the blob store, whole.
    const spilled = [
      ...blobs.objects.values(),
    ].filter((text) => text.length > SIZE);
    expect(spilled).toHaveLength(1);

    // A harness on an edited document reads it back and finishes the turn on it.
    const second = harness('new', false);
    await second.execute('hello', delivery);
    expect((await second.getAgentResponse(delivery)).text).toBe('reply-1');
    await second.close();
    expect(seen).toEqual([
      1,
      1,
    ]);
    // The copy went with the turn.
    expect(
      [
        ...blobs.objects.values(),
      ].filter((text) => text.length > SIZE),
    ).toEqual([]);
  });
});
