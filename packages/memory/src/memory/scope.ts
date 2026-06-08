import type {
  ExecutionContext,
  MemoryScope,
  ScopedStorage,
  StorageAdapter,
} from '@noetic-tools/types';

export function resolveScopeKey(scope: MemoryScope, ctx: ExecutionContext): string {
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
  };
}
