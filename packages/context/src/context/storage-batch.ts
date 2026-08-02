/**
 * Batch reads over a `StorageAdapter`, with the fallback every caller would
 * otherwise write itself.
 *
 * `StorageAdapter.getMany` is optional — an adapter published before it existed
 * is still valid — so no consumer may call it directly. They call this instead:
 * one round trip where the backend supports it, a parallel `get` sweep where it
 * does not. The sweep is deliberately parallel, since the loops this replaces
 * were serial and paid full latency per key.
 */

import type { StorageAdapter } from '@noetic-tools/types';

/**
 * @public
 * Read many keys at once. Keys with no stored value are absent from the result,
 * so both paths agree: `null` never appears as a value, and `map.size` counts
 * only what was actually there.
 */
export async function storageGetMany<T>(
  storage: Pick<StorageAdapter, 'get' | 'getMany'>,
  keys: string[],
): Promise<Map<string, T>> {
  if (keys.length === 0) {
    /* Touch storage for nothing and a D1-backed adapter still pays a query. */
    return new Map<string, T>();
  }
  if (storage.getMany) {
    return storage.getMany<T>(keys);
  }
  const values = await Promise.all(keys.map((key) => storage.get<T>(key)));
  const found = new Map<string, T>();
  for (let i = 0; i < keys.length; i++) {
    const value = values[i];
    if (value === null || value === undefined) {
      continue;
    }
    found.set(keys[i], value);
  }
  return found;
}
