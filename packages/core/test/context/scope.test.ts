import { describe, expect, it } from 'bun:test';
import type { StorageAdapter } from '@noetic-tools/context';
import { createScopedStorage, resolveScopeKey } from '@noetic-tools/context';
import { makeCtx, makeStorage } from '../_helpers';

describe('resolveScopeKey', () => {
  const ctx = makeCtx();

  it('thread scope returns threadId', () => {
    expect(resolveScopeKey('thread', ctx)).toBe('thread-1');
  });

  it('resource scope returns resourceId', () => {
    expect(resolveScopeKey('resource', ctx)).toBe('user-1');
  });

  it('resource scope falls back to threadId', () => {
    expect(
      resolveScopeKey('resource', {
        ...ctx,
        resourceId: undefined,
      }),
    ).toBe('thread-1');
  });

  it('global scope returns __global__', () => {
    expect(resolveScopeKey('global', ctx)).toBe('__global__');
  });

  it('execution scope returns executionId', () => {
    expect(resolveScopeKey('execution', ctx)).toBe('exec-1');
  });
});

describe('createScopedStorage', () => {
  it('namespaces keys', async () => {
    const rawStore = makeStorage();
    const scoped = createScopedStorage(rawStore, 'working-context', 'thread-1');
    await scoped.set('state', {
      foo: 'bar',
    });
    const raw = await rawStore.get<{
      foo: string;
    }>('layers/working-memory/thread-1/state');
    expect(raw).toBeDefined();
    expect(
      await scoped.get<{
        foo: string;
      }>('state'),
    ).toEqual({
      foo: 'bar',
    });
  });

  it('cross-scope isolation', async () => {
    const rawStore = makeStorage();
    const scoped1 = createScopedStorage(rawStore, 'layer-1', 'scope-a');
    const scoped2 = createScopedStorage(rawStore, 'layer-1', 'scope-b');
    await scoped1.set('data', 'value-a');
    await scoped2.set('data', 'value-b');
    expect(await scoped1.get<string>('data')).toBe('value-a');
    expect(await scoped2.get<string>('data')).toBe('value-b');
  });

  it('delete removes namespaced key', async () => {
    const rawStore = makeStorage();
    const scoped = createScopedStorage(rawStore, 'layer-1', 'scope-a');
    await scoped.set('data', 'value');
    await scoped.delete('data');
    expect(await scoped.get('data')).toBeNull();
  });

  it('list strips prefix from returned keys', async () => {
    const rawStore = makeStorage();
    const scoped = createScopedStorage(rawStore, 'layer-1', 'scope-a');
    await scoped.set('key1', 'v1');
    await scoped.set('key2', 'v2');
    const keys = await scoped.list();
    expect(keys).toContain('key1');
    expect(keys).toContain('key2');
    expect(keys).toHaveLength(2);
  });
});

describe('createScopedStorage.getMany', () => {
  it('reads many keys at once and hands back scope-relative keys', async () => {
    const rawStore = makeStorage();
    const scoped = createScopedStorage(rawStore, 'layer-1', 'scope-a');
    await scoped.set('key1', 'v1');
    await scoped.set('key2', 'v2');

    const found = await scoped.getMany<string>([
      'key1',
      'key2',
    ]);

    expect(found.get('key1')).toBe('v1');
    expect(found.get('key2')).toBe('v2');
    // The namespaced form never leaks out, matching `list`.
    expect(found.has('layers/layer-1/scope-a/key1')).toBe(false);
  });

  it('omits keys with nothing stored', async () => {
    const rawStore = makeStorage();
    const scoped = createScopedStorage(rawStore, 'layer-1', 'scope-a');
    await scoped.set('present', 'v');

    const found = await scoped.getMany<string>([
      'present',
      'absent',
    ]);

    expect(found.size).toBe(1);
    expect(found.has('absent')).toBe(false);
  });

  it('does not read across scopes', async () => {
    const rawStore = makeStorage();
    const scoped1 = createScopedStorage(rawStore, 'layer-1', 'scope-a');
    const scoped2 = createScopedStorage(rawStore, 'layer-1', 'scope-b');
    await scoped1.set('data', 'value-a');
    await scoped2.set('data', 'value-b');

    expect(
      (
        await scoped1.getMany<string>([
          'data',
        ])
      ).get('data'),
    ).toBe('value-a');
    expect(
      (
        await scoped2.getMany<string>([
          'data',
        ])
      ).get('data'),
    ).toBe('value-b');
  });

  it('works over an adapter with no batch read of its own', async () => {
    // `makeStorage` implements `getMany`; strip it to exercise the fallback the
    // scoped wrapper inherits from `storageGetMany`.
    const rawStore = makeStorage();
    const legacy: StorageAdapter = {
      get: (key) => rawStore.get(key),
      set: (key, value) => rawStore.set(key, value),
      delete: (key) => rawStore.delete(key),
      list: (prefix) => rawStore.list(prefix),
    };
    const scoped = createScopedStorage(legacy, 'layer-1', 'scope-a');
    await scoped.set('key1', 'v1');

    const found = await scoped.getMany<string>([
      'key1',
      'nope',
    ]);

    expect(found.size).toBe(1);
    expect(found.get('key1')).toBe('v1');
  });
});
