import type { StorageAdapter } from '@noetic-tools/core';

//#region Types

/**
 * @public
 * The part of a SQLite statement this adapter uses. `bun:sqlite`, `node:sqlite`
 * and `better-sqlite3` statements all fit.
 */
export interface SqliteStatement {
  run(...params: string[]): {
    changes: number | bigint;
  };
  get(...params: string[]): unknown;
  all(...params: string[]): unknown[];
}

/**
 * @public
 * The part of an open SQLite database this adapter uses. Pass a `Database` from
 * `bun:sqlite`, a `DatabaseSync` from `node:sqlite`, or a `better-sqlite3` database.
 */
export interface SqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStatement;
}

/** @public Options for `createSqliteStorage`. */
export interface CreateSqliteStorageOptions {
  /** An open database. The caller owns it and closes it. */
  database: SqliteDatabase;
  /** Table the entries live in. Created when missing. Default `noetic_storage`. */
  table?: string;
}

//#endregion

//#region Helpers

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Identity coercion at the JSON.parse boundary: the `StorageAdapter` contract hands
// the responsibility for `<T>` back to the caller, as `createFileStorage` does.
function typedCast<T>(value: unknown): T {
  // @ts-expect-error — identity coercion at the JSON.parse boundary
  return value;
}

function storedValue(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null || !('value' in row)) {
    return undefined;
  }
  return typeof row.value === 'string' ? row.value : undefined;
}

function storedKey(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null || !('key' in row)) {
    return undefined;
  }
  return typeof row.key === 'string' ? row.key : undefined;
}

//#endregion

//#region Factory

/**
 * @public
 * A `StorageAdapter` over one SQLite table, one row per key, with `swap`: the
 * compare-and-set a turn lease needs (spec 23 § One writer per turn). Every
 * process that opens the same database file shares one storage, and SQLite makes
 * each statement atomic across them.
 *
 * Values are stored as their JSON encoding. `swap` compares encodings, so pass
 * `prev` as it was read from this storage.
 *
 * A write that fails throws; nothing is swallowed.
 *
 * @throws Error when `table` is not a plain identifier.
 */
export function createSqliteStorage(options: CreateSqliteStorageOptions): StorageAdapter {
  const table = options.table ?? 'noetic_storage';
  if (!TABLE_NAME.test(table)) {
    throw new Error(`createSqliteStorage: "${table}" is not a valid table name.`);
  }
  const db = options.database;
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const select = db.prepare(`SELECT value FROM ${table} WHERE key = ?`);
  const upsert = db.prepare(
    `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  const remove = db.prepare(`DELETE FROM ${table} WHERE key = ?`);
  const listKeys = db.prepare(`SELECT key FROM ${table} WHERE substr(key, 1, length(?)) = ?`);
  const create = db.prepare(
    `INSERT INTO ${table} (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING`,
  );
  const replace = db.prepare(`UPDATE ${table} SET value = ? WHERE key = ? AND value = ?`);

  function read<T>(key: string): T | null {
    const raw = storedValue(select.get(key));
    return raw === undefined ? null : typedCast<T>(JSON.parse(raw));
  }

  return {
    async get<T>(key: string): Promise<T | null> {
      return read<T>(key);
    },
    async set<T>(key: string, value: T): Promise<void> {
      upsert.run(key, JSON.stringify(value));
    },
    async delete(key: string): Promise<void> {
      remove.run(key);
    },
    async list(prefix: string): Promise<string[]> {
      const keys: string[] = [];
      for (const row of listKeys.all(prefix, prefix)) {
        const key = storedKey(row);
        if (key !== undefined) {
          keys.push(key);
        }
      }
      return keys;
    },
    async getMany<T>(keys: string[]): Promise<Map<string, T>> {
      const found = new Map<string, T>();
      for (const key of keys) {
        const value = read<T>(key);
        if (value === null) {
          continue;
        }
        found.set(key, value);
      }
      return found;
    },
    async swap<T>(key: string, prev: T | null, next: T): Promise<boolean> {
      const encoded = JSON.stringify(next);
      const result =
        prev === null ? create.run(key, encoded) : replace.run(encoded, key, JSON.stringify(prev));
      return Number(result.changes) === 1;
    },
  };
}

//#endregion
