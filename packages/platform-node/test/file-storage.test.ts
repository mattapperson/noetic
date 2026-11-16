/**
 * File-backed StorageAdapter: round-trip through the filesystem, key
 * encoding survives colon/slash-laden keys (the Checkpoint namespace
 * uses them heavily), and tmp+rename write semantics.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import assert from 'node:assert';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFileStorage } from '../src/file-storage';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'noetic-file-storage-'));
});

afterEach(() => {
  if (existsSync(root)) {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
});

describe('createFileStorage', () => {
  it('round-trips a value through set/get with a colon-laden key', async () => {
    const storage = createFileStorage({
      root,
    });
    await storage.set('execution:abc:frontier', {
      hello: 'world',
      n: 42,
    });
    const loaded = await storage.get<{
      hello: string;
      n: number;
    }>('execution:abc:frontier');
    expect(loaded).toEqual({
      hello: 'world',
      n: 42,
    });
  });

  it('get returns null for missing keys', async () => {
    const storage = createFileStorage({
      root,
    });
    expect(await storage.get<string>('does-not-exist')).toBeNull();
  });

  it('delete removes a key without erroring on a second delete', async () => {
    const storage = createFileStorage({
      root,
    });
    await storage.set('x', 1);
    await storage.delete('x');
    await storage.delete('x');
    expect(await storage.get<number>('x')).toBeNull();
  });

  it('list(prefix) filters to keys with the prefix', async () => {
    const storage = createFileStorage({
      root,
    });
    await storage.set('execution:1:snapshot', {
      a: 1,
    });
    await storage.set('execution:2:snapshot', {
      a: 2,
    });
    await storage.set('other:thing', {
      a: 3,
    });
    const keys = await storage.list('execution:');
    expect(keys.sort()).toEqual([
      'execution:1:snapshot',
      'execution:2:snapshot',
    ]);
  });

  it('creates the root directory on demand', async () => {
    const nested = path.join(root, 'deep', 'nest');
    const storage = createFileStorage({
      root: nested,
    });
    await storage.set('k', 'v');
    expect(existsSync(nested)).toBe(true);
    expect(await storage.get<string>('k')).toBe('v');
  });
});

describe('key encoding round-trips (P6)', () => {
  it('keys containing double underscores survive set → list → get', async () => {
    const storage = createFileStorage({
      root,
    });
    // The old scheme decoded '__' back into '%' and threw, making the key
    // invisible to list() while get() still found it.
    const nasty = [
      'thread:__default__:itemLog:00000001',
      'a__b',
      'a_ub',
      'plain_underscore',
      'execution:abc:ledger:00000001',
    ];
    for (const key of nasty) {
      await storage.set(key, {
        key,
      });
    }
    const listed = await storage.list('');
    for (const key of nasty) {
      expect(listed).toContain(key);
      expect(
        await storage.get<{
          key: string;
        }>(key),
      ).toEqual({
        key,
      });
    }
  });

  it('list is served from the index and stays correct across delete', async () => {
    const storage = createFileStorage({
      root,
    });
    await storage.set('p:1', 1);
    await storage.set('p:2', 2);
    await storage.delete('p:1');
    expect(await storage.list('p:')).toEqual([
      'p:2',
    ]);
  });

  it('serializes overlapping writes through unique temporary files', async () => {
    const storage = createFileStorage({
      root,
    });
    await Promise.all(
      Array.from(
        {
          length: 20,
        },
        (_, value) => storage.set('shared', value),
      ),
    );
    const stored = await storage.get<number>('shared');
    expect(stored).toBeGreaterThanOrEqual(0);
    expect(stored).toBeLessThan(20);
    expect(readdirSync(root).filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });

  it('a fresh adapter over an existing root seeds its index from disk', async () => {
    const first = createFileStorage({
      root,
    });
    await first.set('seeded:key__with__underscores', 42);
    const second = createFileStorage({
      root,
    });
    expect(await second.list('seeded:')).toEqual([
      'seeded:key__with__underscores',
    ]);
    expect(await second.get<number>('seeded:key__with__underscores')).toBe(42);
  });
});

describe('legacy on-disk key encoding (pre-_u-escape)', () => {
  /**
   * The encoder gained a `_` → `_u` pre-escape pass. That changed the
   * filename for every key containing `_`, so files written by the previous
   * release were still enumerable (`decodeKey` handles the old names) but
   * unreadable — `get()` computed the new name and missed. These tests seed
   * files under the OLD scheme directly and pin the read-side fallback.
   */
  function legacyEncodeKey(key: string): string {
    return encodeURIComponent(key).replace(/%/g, '__');
  }

  function seedLegacy(key: string, value: unknown): string {
    const file = path.join(root, `${legacyEncodeKey(key)}.json`);
    writeFileSync(file, JSON.stringify(value));
    return file;
  }

  function currentEncodeKey(key: string): string {
    return encodeURIComponent(key.replaceAll('_', '_u')).replace(/%/g, '__');
  }

  it('reads a key with a single underscore written by the old encoder', async () => {
    // The scope-storage shape from the finding: layers/<layerId>/<scope>/state.
    const key = 'layers/my_layer/res_1/state';
    const legacyFile = seedLegacy(key, {
      facts: [
        'remembered',
      ],
    });
    // Pin the exact legacy filename so a future encoder change cannot make
    // this test vacuous by seeding a name nothing ever wrote.
    expect(path.basename(legacyFile)).toBe('layers__2Fmy_layer__2Fres_1__2Fstate.json');

    const storage = createFileStorage({
      root,
    });
    expect(
      await storage.get<{
        facts: string[];
      }>(key),
    ).toEqual({
      facts: [
        'remembered',
      ],
    });
  });

  it('reads a key containing __ written by the old encoder', async () => {
    // The original data-loss case: the old decoder threw on this name, so the
    // construction-time index scan skips it and only the read can surface it.
    const key = 'thread:__default__:itemLog:00000001';
    seedLegacy(key, {
      n: 7,
    });
    const storage = createFileStorage({
      root,
    });
    expect(
      await storage.get<{
        n: number;
      }>(key),
    ).toEqual({
      n: 7,
    });
    // A read proved the key exists, so list() must advertise it too.
    expect(await storage.list('thread:')).toContain(key);
  });

  it('migrates the legacy file onto the canonical name so the second read is a fast path', async () => {
    const key = 'layers/user_facts/user_123/state';
    seedLegacy(key, 'v1');
    const storage = createFileStorage({
      root,
    });
    expect(await storage.get<string>(key)).toBe('v1');

    // After migration exactly one file remains, under the new encoding.
    const files = readdirSync(root);
    expect(files).toEqual([
      `${currentEncodeKey(key)}.json`,
    ]);
    expect(files).not.toContain(`${legacyEncodeKey(key)}.json`);

    // Second read resolves from the canonical name.
    expect(await storage.get<string>(key)).toBe('v1');
  });

  it('set over a legacy key retires the legacy file and round-trips the new value', async () => {
    const key = 'layers/my_layer/res_1/state';
    seedLegacy(key, 'stale');
    const storage = createFileStorage({
      root,
    });
    await storage.set(key, 'fresh');
    expect(readdirSync(root)).toEqual([
      `${currentEncodeKey(key)}.json`,
    ]);
    expect(await storage.get<string>(key)).toBe('fresh');
  });

  it('delete removes the legacy file so the fallback cannot resurrect it', async () => {
    const key = 'layers/my_layer/res_1/state';
    seedLegacy(key, 'stale');
    const storage = createFileStorage({
      root,
    });
    await storage.delete(key);
    expect(await storage.get<string>(key)).toBeNull();
    expect(readdirSync(root)).toEqual([]);
    expect(await storage.list('layers/')).toEqual([]);
  });

  it('delete → set → delete leaves no legacy copy behind', async () => {
    const key = 'layers/my_layer/res_1/state';
    seedLegacy(key, 'stale');
    const storage = createFileStorage({
      root,
    });
    await storage.delete(key);
    await storage.set(key, 'recreated');
    expect(await storage.get<string>(key)).toBe('recreated');
    await storage.delete(key);
    // The stale legacy value must not come back through the fallback read.
    expect(await storage.get<string>(key)).toBeNull();
    expect(readdirSync(root)).toEqual([]);
  });

  it('getMany resolves legacy-encoded keys alongside canonical ones', async () => {
    const legacyKey = 'layers/my_layer/res_1/state';
    seedLegacy(legacyKey, 'old');
    const storage = createFileStorage({
      root,
    });
    await storage.set('layers/plain/res/state', 'new');
    // `getMany` is optional on the StorageAdapter contract; this adapter
    // implements it, and the batch path must inherit the legacy fallback.
    assert(storage.getMany);
    const found = await storage.getMany<string>([
      legacyKey,
      'layers/plain/res/state',
    ]);
    expect(found.get(legacyKey)).toBe('old');
    expect(found.get('layers/plain/res/state')).toBe('new');
  });

  it('does not serve one key from another key’s canonical file', async () => {
    // The legacy scheme is not injective against the new one: key
    // 'plain_nderscore' encodes canonically to 'plain_underscore.json', which
    // is also the LEGACY name for key 'plain_underscore'. A naive fallback
    // would leak across keys — worse than the null it set out to avoid.
    const storage = createFileStorage({
      root,
    });
    await storage.set('plain_nderscore', 'belongs-to-nderscore');
    expect(await storage.get<string>('plain_underscore')).toBeNull();
    expect(await storage.get<string>('plain_nderscore')).toBe('belongs-to-nderscore');
  });

  it('list stays consistent across a legacy read, set, and delete', async () => {
    const key = 'layers/my_layer/res_1/state';
    seedLegacy(key, 'old');
    const storage = createFileStorage({
      root,
    });
    // Seeded from the construction-time scan (the legacy name decodes).
    expect(await storage.list('layers/')).toEqual([
      key,
    ]);
    expect(await storage.get<string>(key)).toBe('old');
    expect(await storage.list('layers/')).toEqual([
      key,
    ]);
    await storage.set(key, 'new');
    expect(await storage.list('layers/')).toEqual([
      key,
    ]);
    await storage.delete(key);
    expect(await storage.list('layers/')).toEqual([]);
  });
});
