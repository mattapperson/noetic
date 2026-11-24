import type { StorageAdapter } from '@noetic-tools/core';

import { decoded, prefixEnd, storedKey, storedValue, tableName } from './storage-values';

//#region Types

/** @public The part of a D1 prepared statement this adapter uses. */
export interface D1StatementLike {
  bind(...values: string[]): D1StatementLike;
  first(): Promise<unknown>;
  all(): Promise<{
    results?: unknown[];
  }>;
  run(): Promise<{
    meta: {
      changes?: number;
    };
  }>;
}

/** @public The part of a D1 database binding this adapter uses. Pass `env.DB`. */
export interface D1DatabaseLike {
  prepare(query: string): D1StatementLike;
}

/** @public Options for `createD1Storage`. */
export interface CreateD1StorageOptions {
  /** The D1 binding. */
  database: D1DatabaseLike;
  /** Table the entries live in. Created when missing. Default `noetic_storage`. */
  table?: string;
}

//#endregion

//#region Factory

/**
 * @public
 * A `StorageAdapter` over one D1 table, one row per key, with `swap`: the
 * compare-and-set a turn lease needs (spec 23 § One writer per turn). Every Worker
 * bound to the same database shares one storage. `swap` is a single conditional
 * statement, so D1 decides the winner.
 *
 * Values are stored as their JSON encoding. `swap` compares encodings, so pass
 * `prev` as it was read from this storage.
 *
 * A write that fails throws; nothing is swallowed.
 *
 * @throws Error when `table` is not a plain identifier.
 */
export function createD1Storage(options: CreateD1StorageOptions): StorageAdapter {
  const table = tableName(options.table, 'createD1Storage');
  const db = options.database;
  let created: Promise<unknown> | undefined;

  /** The table is made on first use: a Worker has no startup step to make it in. */
  function ready(): Promise<unknown> {
    created ??= db
      .prepare(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`)
      .run()
      .catch((error: unknown) => {
        created = undefined;
        throw error;
      });
    return created;
  }

  async function read<T>(key: string): Promise<T | null> {
    await ready();
    const raw = storedValue(
      await db.prepare(`SELECT value FROM ${table} WHERE key = ?`).bind(key).first(),
    );
    return raw === undefined ? null : decoded<T>(raw);
  }

  return {
    get: read,
    async set<T>(key: string, value: T): Promise<void> {
      await ready();
      await db
        .prepare(
          `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .bind(key, JSON.stringify(value))
        .run();
    },
    async delete(key: string): Promise<void> {
      await ready();
      await db.prepare(`DELETE FROM ${table} WHERE key = ?`).bind(key).run();
    },
    async list(prefix: string): Promise<string[]> {
      await ready();
      const { results } = await db
        .prepare(
          `SELECT key FROM ${table} WHERE key >= ? AND key < ? AND substr(key, 1, length(?)) = ?`,
        )
        .bind(prefix, prefixEnd(prefix), prefix, prefix)
        .all();
      return (results ?? []).flatMap((row) => storedKey(row) ?? []);
    },
    async swap<T>(key: string, prev: T | null, next: T): Promise<boolean> {
      await ready();
      const encoded = JSON.stringify(next);
      const statement =
        prev === null
          ? db
              .prepare(
                `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`,
              )
              .bind(key, encoded)
          : db
              .prepare(`UPDATE ${table} SET value = ? WHERE key = ? AND value = ?`)
              .bind(encoded, key, JSON.stringify(prev));
      return (await statement.run()).meta.changes === 1;
    },
  };
}

//#endregion
