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
  /** Run statements in one transaction, as the D1 binding does. */
  batch?(statements: D1StatementLike[]): Promise<
    Array<{
      results?: unknown[];
    }>
  >;
}

/** @public Options for `createD1Storage`. */
export interface CreateD1StorageOptions {
  /** The D1 binding. */
  database: D1DatabaseLike;
  /** Table the entries live in. Created when missing. Default `noetic_storage`. */
  table?: string;
  /**
   * Keep this storage's rows apart from others in the same table: one scope per
   * tenant, user or environment. The table is then `(scope, key, value)`. Every
   * adapter on one table is scoped, or none is.
   */
  scope?: string;
  /** Write values too large for a row to a blob store, and keep a pointer in the row. */
  spill?: SpillOptions;
}

//#endregion

//#region Factory

/**
 * @public
 * A `StorageAdapter` over one D1 table, one row per key, with `swap`: the
 * compare-and-set a turn lease needs (spec 23 § One writer per turn). Every Worker
 * bound to the same database shares one storage, or with `scope`, one storage per
 * scope. `swap` is a single conditional statement, so D1 decides the winner.
 *
 * Values are stored as their JSON encoding. `swap` compares encodings, so pass
 * `prev` as it was read from this storage. A D1 row holds about 2 MB: give `spill`
 * a blob store for values that can grow past that, such as a long thread's record.
 *
 * A write that fails throws; nothing is swallowed.
 *
 * @throws Error when `table` is not a plain identifier, or `scope` is empty; and
 *   from the first call, when the table's shape does not match `scope` (a scoped
 *   table read without one, or the reverse).
 */
export function createD1Storage(options: CreateD1StorageOptions): StorageAdapter {
  const sql = storageTable(
    tableName(options.table, 'createD1Storage'),
    options.scope,
    'createD1Storage',
  );
  const db = options.database;
  let created: Promise<unknown> | undefined;

  /** The table is made on first use: a Worker has no startup step to make it in. */
  function ready(): Promise<unknown> {
    created ??= db
      .prepare(sql.create)
      .run()
      .then(() => db.prepare(sql.columns).all())
      .then(({ results }) => sql.checkShape(results ?? []))
      .catch((error: unknown) => {
        created = undefined;
        throw error;
      });
    return created;
  }

  async function raw(key: string): Promise<string | undefined> {
    await ready();
    return storedValue(
      await db
        .prepare(sql.select)
        .bind(...sql.scope, key)
        .first(),
    );
  }

  const storage: StorageAdapter = {
    async get<T>(key: string): Promise<T | null> {
      const stored = await raw(key);
      return stored === undefined ? null : decoded<T>(stored);
    },
    async set<T>(key: string, value: T): Promise<void> {
      await ready();
      await db
        .prepare(sql.upsert)
        .bind(...sql.scope, key, JSON.stringify(value))
        .run();
    },
    async delete(key: string): Promise<void> {
      await ready();
      await db
        .prepare(sql.remove)
        .bind(...sql.scope, key)
        .run();
    },
    async list(prefix: string): Promise<string[]> {
      await ready();
      const { results } = await db
        .prepare(sql.list)
        .bind(...sql.scope, prefix, prefixEnd(prefix), prefix, prefix)
        .all();
      return (results ?? []).flatMap((row) => storedKey(row) ?? []);
    },
    async getMany<T>(keys: string[]): Promise<Map<string, T>> {
      await ready();
      const found = new Map<string, T>();
      for (const group of keyGroups(keys)) {
        const { results } = await db
          .prepare(sql.selectMany(group.length))
          .bind(...sql.scope, ...group)
          .all();
        collectRows(results ?? [], found);
      }
      return found;
    },
    async swap<T>(key: string, prev: T | null, next: T): Promise<boolean> {
      await ready();
      const encoded = JSON.stringify(next);
      const statement =
        prev === null
          ? db.prepare(sql.insertNew).bind(...sql.scope, key, encoded)
          : db.prepare(sql.replace).bind(encoded, ...sql.scope, key, JSON.stringify(prev));
      return (await statement.run()).meta.changes === 1;
    },
  };
  const batch = db.batch?.bind(db);
  if (!options.spill || !batch) {
    return withSpill({
      storage,
      spill: options.spill,
      scope: options.scope,
    });
  }

  // SQLite rejects some valid JSON, including deeply nested values. If its guard
  // skipped the write, parse in JavaScript and change only the exact row we read.
  const change = async (
    key: string,
    prepare: () => D1StatementLike,
    compare: (before: string) => D1StatementLike,
  ): Promise<unknown> => {
    await ready();
    while (true) {
      const [before, changed] = await batch([
        db.prepare(sql.select).bind(...sql.scope, key),
        prepare(),
      ]);
      const stored = storedValue(before?.results?.[0]);
      if (stored === undefined) {
        return null;
      }
      const prior = decoded(stored);
      if (changed?.results?.length || (await compare(stored).run()).meta.changes === 1) {
        return prior;
      }
    }
  };

  return withSpill({
    storage,
    spill: options.spill,
    scope: options.scope,
    rows: {
      replace(key, value) {
        const encoded = JSON.stringify(value);
        return change(
          key,
          () => db.prepare(sql.upsertJson).bind(...sql.scope, key, encoded),
          (before) => db.prepare(sql.replace).bind(encoded, ...sql.scope, key, before),
        );
      },
      remove: (key) =>
        change(
          key,
          () => db.prepare(sql.removeJson).bind(...sql.scope, key),
          (before) => db.prepare(sql.removeValue).bind(...sql.scope, key, before),
        ),
      async holds(key, value) {
        return (await raw(key)) === JSON.stringify(value);
      },
    },
  });
}

//#endregion
