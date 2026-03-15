import { describe, it, expect } from 'bun:test';
import { resolveScopeKey, createScopedStorage } from '../../src/memory/scope';
import type { ExecutionContext, StorageAdapter } from '../../src/types/memory';

describe('resolveScopeKey', () => {
  const ctx: ExecutionContext = { executionId: 'exec-1', threadId: 'thread-1', resourceId: 'user-1', depth: 0 };

  it('thread scope returns threadId', () => {
    expect(resolveScopeKey('thread', ctx)).toBe('thread-1');
  });

  it('resource scope returns resourceId', () => {
    expect(resolveScopeKey('resource', ctx)).toBe('user-1');
  });

  it('resource scope falls back to threadId', () => {
    expect(resolveScopeKey('resource', { ...ctx, resourceId: undefined })).toBe('thread-1');
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
    const store = new Map<string, unknown>();
    const adapter: StorageAdapter = {
      async get(key) { return (store.get(key) as any) ?? null; },
      async set(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
      async list(prefix) { return [...store.keys()].filter(k => k.startsWith(prefix)); },
    };
    const scoped = createScopedStorage(adapter, 'working-memory', 'thread-1');
    await scoped.set('state', { foo: 'bar' });
    expect(store.has('layers/working-memory/thread-1/state')).toBe(true);
    expect(await scoped.get<{ foo: string }>('state')).toEqual({ foo: 'bar' });
  });

  it('cross-scope isolation', async () => {
    const store = new Map<string, unknown>();
    const adapter: StorageAdapter = {
      async get(key) { return (store.get(key) as any) ?? null; },
      async set(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
      async list(prefix) { return [...store.keys()].filter(k => k.startsWith(prefix)); },
    };
    const scoped1 = createScopedStorage(adapter, 'layer-1', 'scope-a');
    const scoped2 = createScopedStorage(adapter, 'layer-1', 'scope-b');
    await scoped1.set('data', 'value-a');
    await scoped2.set('data', 'value-b');
    expect(await scoped1.get<string>('data')).toBe('value-a');
    expect(await scoped2.get<string>('data')).toBe('value-b');
  });

  it('delete removes namespaced key', async () => {
    const store = new Map<string, unknown>();
    const adapter: StorageAdapter = {
      async get(key) { return (store.get(key) as any) ?? null; },
      async set(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
      async list(prefix) { return [...store.keys()].filter(k => k.startsWith(prefix)); },
    };
    const scoped = createScopedStorage(adapter, 'layer-1', 'scope-a');
    await scoped.set('data', 'value');
    await scoped.delete('data');
    expect(await scoped.get('data')).toBeNull();
  });

  it('list strips prefix from returned keys', async () => {
    const store = new Map<string, unknown>();
    const adapter: StorageAdapter = {
      async get(key) { return (store.get(key) as any) ?? null; },
      async set(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
      async list(prefix) { return [...store.keys()].filter(k => k.startsWith(prefix)); },
    };
    const scoped = createScopedStorage(adapter, 'layer-1', 'scope-a');
    await scoped.set('key1', 'v1');
    await scoped.set('key2', 'v2');
    const keys = await scoped.list();
    expect(keys).toContain('key1');
    expect(keys).toContain('key2');
    expect(keys).toHaveLength(2);
  });
});
