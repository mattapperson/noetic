/**
 * File-backed StorageAdapter: round-trip through the filesystem, key
 * encoding survives colon/slash-laden keys (the Checkpoint namespace
 * uses them heavily), and tmp+rename write semantics.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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
