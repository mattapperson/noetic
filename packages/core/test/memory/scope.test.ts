import { describe, expect, it } from 'bun:test';
import { createScopedStorage, resolveScopeKey } from '../../src/memory/scope';
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
    const scoped = createScopedStorage(rawStore, 'working-memory', 'thread-1');
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
