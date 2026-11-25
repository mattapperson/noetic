import type { StorageAdapter } from '@noetic-tools/core';

import type { SpillOptions } from './spill-storage';
import { withSpill } from './spill-storage';
import {
  collectRows,
  decoded,
  keyGroups,
  prefixEnd,
  storageTable,
  storedKey,
  storedValue,
  tableName,
} from './storage-values';

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
  /**
   * Keep this storage's rows apart from others in the same table. The table is
   * then `(scope, key, value)`. Every adapter on one table is scoped, or none is.
   */
  scope?: string;
  /** Write values too large for a row to a blob store, and keep a pointer in the row. */
  spill?: SpillOptions;
}

//#endregion

//#region Factory

/**
 * @public
 * A `StorageAdapter` over one table of a Durable Object's SQLite storage, with
 * `swap` (spec 23 § One writer per turn). The storage belongs to one object, so
 * one object is one storage: put a thread, or a tenant, in each. `scope` keeps
 * several storages apart inside one object.
 *
 * `swap` reads, compares and writes with no `await` between, which a Durable
 * Object runs as one atomic step.
 *
 * Values are stored as their JSON encoding. `swap` compares encodings, so pass
 * `prev` as it was read from this storage. A row holds about 2 MB: give `spill` a
 * blob store for values that can grow past that.
 *
 * @throws Error when `table` is not a plain identifier, `scope` is empty, or the
 *   table's shape does not match `scope` (a scoped table used without one, or the reverse).
 */
export function createDurableObjectStorage(
  options: CreateDurableObjectStorageOptions,
): StorageAdapter {
  const statements = storageTable(
    tableName(options.table, 'createDurableObjectStorage'),
    options.scope,
    'createDurableObjectStorage',
  );
  const { sql } = options;
  sql.exec(statements.create);
  statements.checkShape(sql.exec(statements.columns).toArray());

  function raw(key: string): string | undefined {
    const [row] = sql.exec(statements.select, ...statements.scope, key).toArray();
    return storedValue(row);
  }

  function write(key: string, encoded: string): void {
    sql.exec(statements.upsert, ...statements.scope, key, encoded);
  }

  const storage: StorageAdapter = {
    async get<T>(key: string): Promise<T | null> {
      const stored = raw(key);
      return stored === undefined ? null : decoded<T>(stored);
    },
    async set<T>(key: string, value: T): Promise<void> {
      write(key, JSON.stringify(value));
    },
    async delete(key: string): Promise<void> {
      sql.exec(statements.remove, ...statements.scope, key);
    },
    async list(prefix: string): Promise<string[]> {
      return sql
        .exec(statements.list, ...statements.scope, prefix, prefixEnd(prefix), prefix, prefix)
        .toArray()
        .flatMap((row) => storedKey(row) ?? []);
    },
    async getMany<T>(keys: string[]): Promise<Map<string, T>> {
      const found = new Map<string, T>();
      for (const group of keyGroups(keys)) {
        collectRows(
          sql.exec(statements.selectMany(group.length), ...statements.scope, ...group).toArray(),
          found,
        );
      }
      return found;
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
  return withSpill(storage, options.spill, options.scope);
}

//#endregion
