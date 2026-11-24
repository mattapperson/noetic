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
