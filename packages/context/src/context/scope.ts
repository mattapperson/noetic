import type {
  ContextScope,
  ExecutionContext,
  ScopedStorage,
  StorageAdapter,
} from '@noetic-tools/types';

import { storageGetMany } from './storage-batch';

export function resolveScopeKey(scope: ContextScope, ctx: ExecutionContext): string {
  switch (scope) {
    case 'thread':
      return ctx.threadId;
    case 'resource':
      return ctx.resourceId ?? ctx.threadId;
    case 'global':
      return '__global__';
    case 'execution':
      return ctx.executionId;
  }
}

export function createScopedStorage(
  storage: StorageAdapter,
  layerId: string,
  scopeKey: string,
): ScopedStorage {
  const prefix = `layers/${layerId}/${scopeKey}/`;
  return {
    async get<T>(key: string): Promise<T | null> {
      return storage.get<T>(`${prefix}${key}`);
    },
    async set<T>(key: string, value: T): Promise<void> {
      return storage.set(`${prefix}${key}`, value);
    },
    async delete(key: string): Promise<void> {
      return storage.delete(`${prefix}${key}`);
    },
    async list(keyPrefix?: string): Promise<string[]> {
      const fullPrefix = keyPrefix ? `${prefix}${keyPrefix}` : prefix;
      const keys = await storage.list(fullPrefix);
      return keys.map((k) => (k.startsWith(prefix) ? k.slice(prefix.length) : k));
    },
    async getMany<T>(keys: string[]): Promise<Map<string, T>> {
      const scoped = await storageGetMany<T>(
        storage,
        keys.map((k) => `${prefix}${k}`),
      );
      // Hand back the keys the caller passed in, not the namespaced ones —
      // `list` already strips the prefix and a layer never sees it otherwise.
      const unscoped = new Map<string, T>();
      for (const [key, value] of scoped) {
        unscoped.set(key.startsWith(prefix) ? key.slice(prefix.length) : key, value);
      }
      return unscoped;
    },
  };
}
