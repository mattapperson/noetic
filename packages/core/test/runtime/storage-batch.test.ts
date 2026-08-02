// Batch reads over a StorageAdapter. `getMany` is optional on the interface, so
// the helper has two paths to keep honest: delegate when the backend has one,
// parallel-sweep `get` when it does not. See issue #58.

import { describe, expect, it } from 'bun:test';
import type { StorageAdapter } from '@noetic-tools/context';
import { storageGetMany } from '@noetic-tools/context';
import { frameworkCast } from '@noetic-tools/types';
import { createInMemoryStorage } from '../../src/runtime/in-memory-storage';

interface StorageSpy {
  storage: StorageAdapter;
  getCalls: string[];
  getManyCalls: string[][];
  /** Resolution order of concurrent `get` calls — proves the sweep is parallel. */
  getSettleOrder: string[];
}

/**
 * A StorageAdapter over a plain object, recording every call. `withGetMany:
 * false` produces a legacy adapter — the shape that predates the batch read.
 *
 * Each `get` yields to the microtask queue before resolving so a serial caller
 * (await inside a loop) and a parallel one (Promise.all) are distinguishable.
 */
function makeSpy(entries: Record<string, unknown>, withGetMany: boolean): StorageSpy {
  const store = new Map<string, unknown>(Object.entries(entries));
  const getCalls: string[] = [];
  const getManyCalls: string[][] = [];
  const getSettleOrder: string[] = [];

  const base = {
    async get<T>(key: string): Promise<T | null> {
      getCalls.push(key);
      await Promise.resolve();
      getSettleOrder.push(key);
      const val = store.get(key);
      return val === undefined ? null : frameworkCast<T>(val);
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(prefix: string): Promise<string[]> {
      return [
        ...store.keys(),
      ].filter((k) => k.startsWith(prefix));
    },
  };

  if (!withGetMany) {
    return {
      storage: base,
      getCalls,
      getManyCalls,
      getSettleOrder,
    };
  }

  return {
    storage: {
      ...base,
      async getMany<T>(keys: string[]): Promise<Map<string, T>> {
        getManyCalls.push([
          ...keys,
        ]);
        const found = new Map<string, T>();
        for (const key of keys) {
          const val = store.get(key);
          if (val === undefined) {
            continue;
          }
          found.set(key, frameworkCast<T>(val));
        }
        return found;
      },
    },
    getCalls,
    getManyCalls,
    getSettleOrder,
  };
}

describe('storageGetMany', () => {
  it('delegates to getMany when the adapter implements it, without touching get', async () => {
    const spy = makeSpy(
      {
        a: 1,
        b: 2,
      },
      true,
    );

    const result = await storageGetMany<number>(spy.storage, [
      'a',
      'b',
    ]);

    expect([
      ...result,
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
    expect(spy.getManyCalls).toEqual([
      [
        'a',
        'b',
      ],
    ]);
    expect(spy.getCalls).toEqual([]);
  });

  it('falls back to one get per key when the adapter has no getMany', async () => {
    const spy = makeSpy(
      {
        a: 1,
        b: 2,
      },
      false,
    );

    const result = await storageGetMany<number>(spy.storage, [
      'a',
      'b',
    ]);

    expect([
      ...result,
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
    expect(spy.getCalls).toEqual([
      'a',
      'b',
    ]);
    expect(spy.getManyCalls).toEqual([]);
  });

  it('issues the fallback gets in parallel, not one awaited round trip per key', async () => {
    const spy = makeSpy(
      {
        a: 1,
        b: 2,
        c: 3,
      },
      false,
    );
    /* Every get is dispatched before any of them resolves. A serial loop would
     * interleave dispatch and settle instead. */
    const dispatched: string[] = [];
    const instrumented: StorageAdapter = {
      ...spy.storage,
      async get<T>(key: string): Promise<T | null> {
        dispatched.push(key);
        return spy.storage.get<T>(key);
      },
    };

    await storageGetMany<number>(instrumented, [
      'a',
      'b',
      'c',
    ]);

    expect(dispatched).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(spy.getSettleOrder.length).toBe(3);
  });

  it('omits missing keys rather than mapping them to null (getMany path)', async () => {
    const spy = makeSpy(
      {
        a: 1,
      },
      true,
    );

    const result = await storageGetMany<number>(spy.storage, [
      'a',
      'missing',
    ]);

    expect(result.size).toBe(1);
    expect(result.has('missing')).toBe(false);
    expect(result.get('a')).toBe(1);
  });

  it('omits missing keys rather than mapping them to null (fallback path)', async () => {
    const spy = makeSpy(
      {
        a: 1,
      },
      false,
    );

    const result = await storageGetMany<number>(spy.storage, [
      'a',
      'missing',
    ]);

    expect(result.size).toBe(1);
    expect(result.has('missing')).toBe(false);
    expect(result.get('a')).toBe(1);
  });

  it('short-circuits on an empty key list without touching storage', async () => {
    const spy = makeSpy(
      {
        a: 1,
      },
      true,
    );

    const result = await storageGetMany<number>(spy.storage, []);

    expect(result.size).toBe(0);
    expect(spy.getCalls).toEqual([]);
    expect(spy.getManyCalls).toEqual([]);
  });

  it('preserves falsy stored values, which are present rather than missing', async () => {
    const spy = makeSpy(
      {
        zero: 0,
        empty: '',
        no: false,
      },
      false,
    );

    const result = await storageGetMany<number | string | boolean>(spy.storage, [
      'zero',
      'empty',
      'no',
    ]);

    expect(result.size).toBe(3);
    expect(result.get('zero')).toBe(0);
    expect(result.get('empty')).toBe('');
    expect(result.get('no')).toBe(false);
  });
});

describe('createInMemoryStorage.getMany', () => {
  it('reads many keys and omits the ones never set', async () => {
    const storage = createInMemoryStorage();
    await storage.set('a', {
      v: 1,
    });
    await storage.set('b', {
      v: 2,
    });

    const result = await storageGetMany<{
      v: number;
    }>(storage, [
      'a',
      'b',
      'never-set',
    ]);

    expect(result.size).toBe(2);
    expect(result.get('a')).toEqual({
      v: 1,
    });
    expect(result.get('b')).toEqual({
      v: 2,
    });
    expect(result.has('never-set')).toBe(false);
  });

  it('reflects a delete', async () => {
    const storage = createInMemoryStorage();
    await storage.set('a', 1);
    await storage.delete('a');

    const result = await storageGetMany<number>(storage, [
      'a',
    ]);

    expect(result.size).toBe(0);
  });
});
