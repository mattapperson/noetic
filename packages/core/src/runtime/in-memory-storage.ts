import { frameworkCast } from '../interpreter/framework-cast';
import type { StorageAdapter } from '../types/memory';

//#region Public API

/**
 * @public Process-local, Map-backed StorageAdapter.
 *
 * The default when no storage is configured on AgentHarness. State lives only
 * for the lifetime of the Map (i.e., this harness instance). Durable backends
 * must be supplied explicitly by the caller.
 */
export function createInMemoryStorage(): StorageAdapter {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const val = store.get(key);
      if (val === undefined) {
        return null;
      }
      return frameworkCast<T>(val);
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
}

//#endregion
