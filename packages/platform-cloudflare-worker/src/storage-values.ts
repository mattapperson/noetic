/**
 * What the two storage adapters share: the table name rule and reading a stored row.
 */

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @internal The table name to use, or a throw when `table` is not a plain identifier. */
export function tableName(table: string | undefined, factory: string): string {
  const name = table ?? 'noetic_storage';
  if (!TABLE_NAME.test(name)) {
    throw new Error(`${factory}: "${name}" is not a valid table name.`);
  }
  return name;
}

/** @internal Keys read per statement: D1 and Durable Object SQL bind at most 100 parameters, one of them the scope. */
export const KEYS_PER_STATEMENT = 90;

/**
 * @internal
 * The statements of one storage table, and the scope they are bound to. Without a
 * scope the table is `(key, value)`; with one it is `(scope, key, value)` and every
 * statement is bound to the scope first, so two scopes never see each other's rows.
 */
export interface StorageTable {
  create: string;
  /** The table's columns, one row each with its `name`. */
  columns: string;
  /**
   * Throw unless `rows`, the result of `columns`, are this adapter's shape: a
   * scoped adapter on an unscoped table, or the reverse, would read and write
   * across scopes.
   */
  checkShape(rows: unknown[]): void;
  select: string;
  upsert: string;
  remove: string;
  list: string;
  /** Insert a key only when it is missing. */
  insertNew: string;
  /** Replace a value only when the key holds the value given last. */
  replace: string;
  /** Select `count` keys' rows. */
  selectMany(count: number): string;
  /** The bindings that lead every statement: the scope, or none. */
  scope: string[];
}

/** @internal The statements for `table`, scoped when `scope` is given. @throws Error for an empty scope. */
export function storageTable(
  table: string,
  scope: string | undefined,
  factory: string,
): StorageTable {
  if (scope === '') {
    throw new Error(`${factory}: scope must not be empty.`);
  }
  const scoped = scope !== undefined;
  const columns = scoped ? 'scope, key' : 'key';
  const places = scoped ? '?, ?' : '?';
  const at = scoped ? 'scope = ? AND key = ?' : 'key = ?';
  const within = scoped ? 'scope = ? AND ' : '';
  return {
    columns: `PRAGMA table_info(${table})`,
    checkShape: (rows) =>
      checkShape(rows, {
        scoped,
        table,
        factory,
      }),
    create: scoped
      ? `CREATE TABLE IF NOT EXISTS ${table} (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key))`
      : `CREATE TABLE IF NOT EXISTS ${table} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    select: `SELECT value FROM ${table} WHERE ${at}`,
    upsert: `INSERT INTO ${table} (${columns}, value) VALUES (${places}, ?) ON CONFLICT(${columns}) DO UPDATE SET value = excluded.value`,
    remove: `DELETE FROM ${table} WHERE ${at}`,
    list: `SELECT key FROM ${table} WHERE ${within}key >= ? AND key < ? AND substr(key, 1, length(?)) = ?`,
    insertNew: `INSERT INTO ${table} (${columns}, value) VALUES (${places}, ?) ON CONFLICT(${columns}) DO NOTHING`,
    replace: `UPDATE ${table} SET value = ? WHERE ${at} AND value = ?`,
    selectMany: (count) =>
      `SELECT key, value FROM ${table} WHERE ${within}key IN (${Array.from(
        {
          length: count,
        },
        () => '?',
      ).join(', ')})`,
    scope: scoped
      ? [
          scope,
        ]
      : [],
  };
}

/** Throw unless a table whose columns are `rows` has a scope column exactly when `scoped`. */
function checkShape(
  rows: unknown[],
  {
    scoped,
    table,
    factory,
  }: {
    scoped: boolean;
    table: string;
    factory: string;
  },
): void {
  const hasScope = rows.some(
    (row) => typeof row === 'object' && row !== null && 'name' in row && row.name === 'scope',
  );
  if (hasScope === scoped) {
    return;
  }
  throw new Error(
    scoped
      ? `${factory}: table "${table}" has no scope column, so a scope cannot keep its rows apart. Use a table of its own.`
      : `${factory}: table "${table}" is scoped. Give this adapter a scope too: without one it would read and write every scope's rows.`,
  );
}

/** @internal `keys` without repeats, in groups one statement can bind. */
export function keyGroups(keys: string[]): string[][] {
  const unique = [
    ...new Set(keys),
  ];
  const groups: string[][] = [];
  for (let start = 0; start < unique.length; start += KEYS_PER_STATEMENT) {
    groups.push(unique.slice(start, start + KEYS_PER_STATEMENT));
  }
  return groups;
}

/** @internal Add each `{ key, value }` row of `rows` to `found`, decoded. */
export function collectRows<T>(rows: unknown[], found: Map<string, T>): void {
  for (const row of rows) {
    const key = storedKey(row);
    const value = storedValue(row);
    if (key !== undefined && value !== undefined) {
      found.set(key, decoded<T>(value));
    }
  }
}

/**
 * @internal
 * The upper end of the key range a prefix covers, so a `list` reads that range from
 * the primary key and does not scan the table. The exact match is still checked.
 */
export function prefixEnd(prefix: string): string {
  return `${prefix}\u{10FFFF}`;
}

/** @internal The `value` column of `row`, when it is a string. */
export function storedValue(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null || !('value' in row)) {
    return undefined;
  }
  return typeof row.value === 'string' ? row.value : undefined;
}

/** @internal The `key` column of `row`, when it is a string. */
export function storedKey(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null || !('key' in row)) {
    return undefined;
  }
  return typeof row.key === 'string' ? row.key : undefined;
}

// Identity coercion at the JSON.parse boundary: the `StorageAdapter` contract hands
// the responsibility for `<T>` back to the caller, as the other adapters do.
function typedCast<T>(value: unknown): T {
  // @ts-expect-error — identity coercion at the JSON.parse boundary
  return value;
}

/** @internal A stored encoding, decoded. */
export function decoded<T>(raw: string): T {
  return typedCast<T>(JSON.parse(raw));
}
