import type { StorageAdapter } from '@noetic-tools/core';

import { decoded, storedKey, storedValue, tableName } from './storage-values';

//#region Types

/**
 * @public
 * The part of a Durable Object's SQL storage this adapter uses. Pass
 * `ctx.storage.sql` from a SQLite-backed Durable Object.
 */
export interface DurableObjectSqlLike {
  exec(
    query: string,
    ...bindings: string[]
  ): {
    toArray(): unknown[];
  };
}

/** @public Options for `createDurableObjectStorage`. */
export interface CreateDurableObjectStorageOptions {
  /** The object's SQL storage: `ctx.storage.sql`. */
  sql: DurableObjectSqlLike;
  /** Table the entries live in. Created when missing. Default `noetic_storage`. */
  table?: string;
}

//#endregion

//#region Factory

/**
 * @public
 * A `StorageAdapter` over one table of a Durable Object's SQLite storage, with
 * `swap` (spec 23 § One writer per turn). The storage belongs to one object, so
 * one object is one storage: put a thread, or a tenant, in each.
 *
 * `swap` reads, compares and writes with no `await` between, which a Durable
 * Object runs as one atomic step.
 *
 * Values are stored as their JSON encoding. `swap` compares encodings, so pass
 * `prev` as it was read from this storage.
 *
 * @throws Error when `table` is not a plain identifier.
 */
export function createDurableObjectStorage(
  options: CreateDurableObjectStorageOptions,
): StorageAdapter {
  const table = tableName(options.table, 'createDurableObjectStorage');
  const { sql } = options;
  sql.exec(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  function raw(key: string): string | undefined {
    const [row] = sql.exec(`SELECT value FROM ${table} WHERE key = ?`, key).toArray();
    return storedValue(row);
  }

  function write(key: string, encoded: string): void {
    sql.exec(
      `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      encoded,
    );
  }

  return {
    async get<T>(key: string): Promise<T | null> {
      const stored = raw(key);
      return stored === undefined ? null : decoded<T>(stored);
    },
    async set<T>(key: string, value: T): Promise<void> {
      write(key, JSON.stringify(value));
    },
    async delete(key: string): Promise<void> {
      sql.exec(`DELETE FROM ${table} WHERE key = ?`, key);
    },
    async list(prefix: string): Promise<string[]> {
      return sql
        .exec(`SELECT key FROM ${table} WHERE substr(key, 1, length(?)) = ?`, prefix, prefix)
        .toArray()
        .flatMap((row) => storedKey(row) ?? []);
    },
    async swap<T>(key: string, prev: T | null, next: T): Promise<boolean> {
      // No `await` from the read to the write: the object runs them as one step.
      const stored = raw(key);
      const expected = prev === null ? undefined : JSON.stringify(prev);
      if (stored !== expected) {
        return false;
      }
      write(key, JSON.stringify(next));
      return true;
    },
  };
}

//#endregion
