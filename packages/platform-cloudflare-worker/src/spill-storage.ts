import type { StorageAdapter } from '@noetic-tools/core';

//#region Types

/**
 * @public
 * The part of a blob store `spillStorage` uses. An R2 bucket binding
 * (`env.BUCKET`) fits as it is.
 */
export interface BlobStoreLike {
  get(key: string): Promise<{
    text(): Promise<string>;
  } | null>;
  put(key: string, value: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/** @public Options for `spillStorage`, and for `spill` on the storage factories. */
export interface SpillOptions {
  /** Where values too large for a row are written. */
  blobs: BlobStoreLike;
  /** A value whose JSON is over this many UTF-8 bytes is spilled. Default `DEFAULT_SPILL_BYTES`. */
  maxBytes?: number;
  /** Leads every object key. Default `noetic-storage`. */
  prefix?: string;
  /**
   * Object key prefixes, besides `prefix`, whose pointers are followed: for rows
   * moved from another layout whose objects keep their keys. A pointer to any
   * other object is read as a plain value and its object is never read or deleted.
   */
  movedPrefixes?: ReadonlyArray<string>;
}

/** What a value is stored as: itself, or a pointer to the object that holds it. */
interface Placed {
  row: unknown;
  /** The object this write made, when the value was spilled. */
  object?: string;
}

/** SQL adapters can return the row displaced by a write in the same operation. */
interface SpillRows {
  replace(key: string, value: unknown): Promise<unknown>;
  remove(key: string): Promise<unknown>;
  /** Compare the exact row encoding so a malformed value cannot block cleanup. */
  holds(key: string, value: unknown): Promise<boolean>;
}

//#endregion

//#region Helpers

/**
 * @public
 * The default `maxBytes`: 1 MiB. The SQL adapters use an inline row budget
 * of about 2 MB, so this leaves room for the row's key and its encoding.
 */
export const DEFAULT_SPILL_BYTES = 1024 * 1024;

const DEFAULT_PREFIX = 'noetic-storage';

// Keep enough room for SQLite's record header and any extra row fields it stores.
const SQL_ROW_BYTES = 2_000_000 - 32;

/** The one key of a pointer row. */
const POINTER_KEY = 'noetic:spilled';

/** How many times a read follows a row whose object has gone, before it gives up. */
const READ_ATTEMPTS = 3;

/** R2's longest object key, in UTF-8 bytes. */
const OBJECT_KEY_BYTES = 1024;

/** The storage key's part of an object key is cut to this many UTF-8 bytes. */
const KEY_PART_BYTES = 200;

/** What a write's own part of an object key takes: `/`, `/` and a UUID. */
const OBJECT_SUFFIX_BYTES = 2 + 36;

/** The object a row points at, when the row is a pointer, whoever made it. */
function pointerIn(row: unknown): string | undefined {
  if (typeof row !== 'object' || row === null || !(POINTER_KEY in row)) {
    return undefined;
  }
  const object = row[POINTER_KEY];
  return typeof object === 'string' && Object.keys(row).length === 1 ? object : undefined;
}

function pointerTo(object: string): unknown {
  return {
    [POINTER_KEY]: object,
  };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** `text` cut to at most `bytes` UTF-8 bytes, never inside a character. */
function cutToBytes(text: string, bytes: number): string {
  let cut = '';
  let used = 0;
  for (const char of text) {
    const size = byteLength(char);
    if (used + size > bytes) {
      break;
    }
    cut += char;
    used += size;
  }
  return cut;
}

/** Delete an object no row points at. A failure leaves an orphan, never a wrong result. */
async function dropObject(blobs: BlobStoreLike, object: string): Promise<void> {
  try {
    await blobs.delete(object);
  } catch (error) {
    console.warn(`[noetic] spillStorage: could not delete ${object}; it is orphaned.`, error);
  }
}

function checkedMaxBytes(maxBytes: number | undefined): number {
  const limit = maxBytes ?? DEFAULT_SPILL_BYTES;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`spillStorage: maxBytes must be a positive number, got ${limit}.`);
  }
  return limit;
}

//#endregion

//#region Factory

/** The spilling storage `spillStorage` makes. */
class Spill {
  private readonly storage: StorageAdapter;
  private readonly blobs: BlobStoreLike;
  private readonly maxBytes: number;
  private readonly prefix: string;
  private readonly keyPartBytes: number;
  /** Object key prefixes whose pointers are followed. */
  private readonly followed: string[];

  constructor(
    storage: StorageAdapter,
    options: SpillOptions,
    private readonly inlineBytes?: (key: string) => number,
    private readonly rows?: SpillRows,
  ) {
    this.storage = storage;
    this.blobs = options.blobs;
    this.maxBytes = checkedMaxBytes(options.maxBytes);
    this.prefix = options.prefix ?? DEFAULT_PREFIX;
    this.keyPartBytes = Math.min(
      KEY_PART_BYTES,
      OBJECT_KEY_BYTES - byteLength(this.prefix) - OBJECT_SUFFIX_BYTES,
    );
    if (this.keyPartBytes < 1) {
      throw new Error(
        `spillStorage: prefix "${this.prefix}" leaves no room in an object key; keep it under ${OBJECT_KEY_BYTES - OBJECT_SUFFIX_BYTES - 1} bytes.`,
      );
    }
    this.followed = [
      `${this.prefix}/`,
      ...(options.movedPrefixes ?? []),
    ];
  }

  /** The object a row points at, when it is a pointer this this.storage made or was told to follow. */
  pointee(row: unknown): string | undefined {
    const object = pointerIn(row);
    return object !== undefined && this.followed.some((start) => object.startsWith(start))
      ? object
      : undefined;
  }

  /** Where `value` goes: the row itself, or a new object the row points at. */
  async place(key: string, value: unknown): Promise<Placed> {
    if (pointerIn(value) !== undefined) {
      throw new Error(
        `spillStorage: "${key}" cannot hold a value whose only key is "${POINTER_KEY}": it would be read as a pointer.`,
      );
    }
    const json = JSON.stringify(value);
    if (
      json === undefined ||
      byteLength(json) <=
        Math.min(this.maxBytes, this.inlineBytes?.(key) ?? Number.POSITIVE_INFINITY)
    ) {
      return {
        row: value,
      };
    }
    const object = `${this.prefix}/${cutToBytes(key, this.keyPartBytes)}/${crypto.randomUUID()}`;
    await this.blobs.put(object, json);
    return {
      row: pointerTo(object),
      object,
    };
  }

  /**
   * Delete the object of a write that did not land. A write that landed but
   * reported failure left the row pointing at it, and it is kept; so is the object
   * of a write whose row cannot be read to tell, since deleting one the row points
   * at would lose the value.
   */
  async unplace(key: string, object: string | undefined): Promise<void> {
    if (object === undefined) {
      return;
    }
    let kept: boolean;
    try {
      kept = this.rows
        ? await this.rows.holds(key, pointerTo(object))
        : this.pointee(await this.storage.get<unknown>(key)) === object;
    } catch {
      return;
    }
    if (!kept) {
      await dropObject(this.blobs, object);
    }
  }

  /** The text of the object `row` points at, or undefined when it is no pointer or the object is gone. */
  async spilledText(row: unknown): Promise<string | undefined> {
    const object = this.pointee(row);
    const held = object === undefined ? null : await this.blobs.get(object);
    return held ? held.text() : undefined;
  }

  /**
   * The value a row stands for. A writer may delete an object between this
   * reader's row read and its object read, so a missing object means the row is
   * read again. One still missing behind an unchanged pointer is corruption, not
   * absence: reading it as absent would restart a turn from nothing.
   */
  async resolve<T>(key: string, first: unknown): Promise<T | null> {
    let row = first;
    for (let attempt = 1; ; attempt++) {
      const object = this.pointee(row);
      if (object === undefined) {
        return typedCast<T>(row);
      }
      const text = await this.spilledText(row);
      if (text !== undefined) {
        return typedCast<T>(JSON.parse(text));
      }
      const again = await this.storage.get<unknown>(key);
      if (again === null) {
        return null;
      }
      if (this.pointee(again) === object || attempt >= READ_ATTEMPTS) {
        throw new Error(`spillStorage: "${key}" points at a missing object: ${object}`);
      }
      row = again;
    }
  }

  /**
   * The row `prev` is stored as, or undefined when the key holds something else.
   * A value is matched as it is when it was stored in the row, and by its
   * object's text when it was spilled, whichever `maxBytes` it was written under.
   */
  async rowHolding(key: string, prev: unknown): Promise<unknown> {
    const json = JSON.stringify(prev);
    if (json === undefined || byteLength(json) <= this.maxBytes) {
      return prev;
    }
    const row = await this.storage.get<unknown>(key);
    if (this.pointee(row) === undefined) {
      return prev;
    }
    return (await this.spilledText(row)) === json ? row : undefined;
  }

  async swapRows(key: string, held: unknown, placed: Placed): Promise<boolean> {
    const inner = this.storage.swap;
    if (!inner) {
      throw new Error('spillStorage: the storage underneath has no swap.');
    }
    try {
      return await inner.call(this.storage, key, held, placed.row);
    } catch (error) {
      // A swap that threw may still have landed, and the row then holds what this
      // call wrote: calling that a loss would tell a lease's holder it was replaced.
      let now: unknown;
      try {
        now = await this.storage.get<unknown>(key);
      } catch {
        // Cannot tell whether it landed: keep the object, and report the failure.
        throw error;
      }
      if (JSON.stringify(now) !== JSON.stringify(placed.row)) {
        await this.unplace(key, placed.object);
        throw error;
      }
      return true;
    }
  }

  async swap<T>(key: string, prev: T | null, next: T): Promise<boolean> {
    let held: unknown = prev;
    if (prev !== null) {
      held = await this.rowHolding(key, prev);
      if (held === undefined) {
        return false;
      }
    }
    const placed = await this.place(key, next);
    let won = await this.swapRows(key, held, placed);
    if (!won && prev !== null && this.pointee(held) === undefined) {
      // `prev` was matched as a row value, and the key may hold it spilled instead:
      // written under a smaller `maxBytes`.
      const row = await this.storage.get<unknown>(key);
      if ((await this.spilledText(row)) === JSON.stringify(prev)) {
        held = row;
        won = await this.swapRows(key, held, placed);
      }
    }
    const stale = won ? this.pointee(held) : placed.object;
    if (stale !== undefined) {
      await dropObject(this.blobs, stale);
    }
    return won;
  }

  async get<T>(key: string): Promise<T | null> {
    const row = await this.storage.get<unknown>(key);
    return row === null ? null : this.resolve<T>(key, row);
  }

  async set<T>(key: string, value: T): Promise<void> {
    const placed = await this.place(key, value);
    let replaced: string | undefined;
    try {
      if (this.rows) {
        replaced = this.pointee(await this.rows.replace(key, placed.row));
      } else {
        replaced = this.pointee(await this.storage.get<unknown>(key));
        await this.storage.set(key, placed.row);
      }
    } catch (error) {
      await this.unplace(key, placed.object);
      throw error;
    }
    if (replaced !== undefined && replaced !== placed.object) {
      await dropObject(this.blobs, replaced);
    }
  }

  async delete(key: string): Promise<void> {
    const row = this.rows ? await this.rows.remove(key) : await this.storage.get<unknown>(key);
    if (!this.rows) {
      await this.storage.delete(key);
    }
    const object = this.pointee(row);
    if (object !== undefined) {
      await dropObject(this.blobs, object);
    }
  }

  /** Read `keys` with `getMany`, the storage underneath's. */
  async getMany<T>(
    keys: string[],
    getMany: NonNullable<StorageAdapter['getMany']>,
  ): Promise<Map<string, T>> {
    const rows = await getMany.call(this.storage, keys);
    const found = new Map<string, T>();
    await Promise.all(
      [
        ...rows,
      ].map(async ([key, row]) => {
        const value = await this.resolve<T>(key, row);
        if (value !== null) {
          found.set(key, value);
        }
      }),
    );
    return found;
  }
}

/**
 * @public
 * `storage`, with values too large for a row kept in a blob store (spec 25
 * § Values larger than a row). A value whose JSON is over `maxBytes` is written to
 * `blobs` and its row holds a pointer; smaller values are stored as before.
 *
 * Each spilled write makes an object of its own, so a pointer names one value for
 * as long as it exists. `swap` on a spilled value compares the object's text with
 * `prev`, then swaps on the pointer in `storage`, which decides the winner as it
 * does for any other value. The write that replaces or deletes a pointer deletes
 * the object it pointed at.
 *
 * The result has `swap` only when `storage` does.
 *
 * @throws Error when `maxBytes` is not a positive number.
 */
export function spillStorage(storage: StorageAdapter, options: SpillOptions): StorageAdapter {
  return wrapSpill(storage, new Spill(storage, options));
}

function wrapSpill(storage: StorageAdapter, spill: Spill): StorageAdapter {
  const spilling: StorageAdapter = {
    get: (key) => spill.get(key),
    set: (key, value) => spill.set(key, value),
    delete: (key) => spill.delete(key),
    list: (prefixOfKeys) => storage.list(prefixOfKeys),
  };
  const getMany = storage.getMany;
  if (getMany) {
    spilling.getMany = (keys) => spill.getMany(keys, getMany);
  }
  if (storage.swap) {
    spilling.swap = (key, prev, next) => spill.swap(key, prev, next);
  }
  return spilling;
}

/**
 * @internal `storage`, spilling when the factory was given `spill`. A scope is
 * added to the prefix, so two scopes' objects are apart as their rows are.
 */
export function withSpill({
  storage,
  spill,
  scope,
  rows,
}: {
  storage: StorageAdapter;
  spill: SpillOptions | undefined;
  scope: string | undefined;
  rows?: SpillRows;
}): StorageAdapter {
  if (!spill) {
    return storage;
  }
  const prefix = spill.prefix ?? DEFAULT_PREFIX;
  const budget = SQL_ROW_BYTES - byteLength(scope ?? '');
  return wrapSpill(
    storage,
    new Spill(
      storage,
      {
        ...spill,
        prefix: scope === undefined ? prefix : `${prefix}/${scope}`,
      },
      (key) => budget - byteLength(key),
      rows,
    ),
  );
}

// Identity coercion at the storage boundary: the `StorageAdapter` contract hands
// the responsibility for `<T>` back to the caller, as the other adapters do.
function typedCast<T>(value: unknown): T {
  // @ts-expect-error — identity coercion at the storage boundary
  return value;
}

//#endregion
