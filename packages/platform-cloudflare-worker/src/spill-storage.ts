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
}

/** What a value is stored as: itself, or a pointer to the object that holds it. */
interface Placed {
  row: unknown;
  /** The object this write made, when the value was spilled. */
  object?: string;
}

//#endregion

//#region Helpers

/**
 * @public
 * The default `maxBytes`: 1 MiB. A D1 row and a Durable Object SQLite row hold
 * about 2 MB, so this leaves room for the row's key and its encoding.
 */
export const DEFAULT_SPILL_BYTES = 1024 * 1024;

const DEFAULT_PREFIX = 'noetic-storage';

/** The one key of a pointer row. */
const POINTER_KEY = 'noetic:spilled';

/** How many times a read follows a row whose object has gone, before it gives up. */
const READ_ATTEMPTS = 3;

/** The storage key's part of an object key is cut to this, so a long key still fits R2's limit. */
const KEY_PART_LENGTH = 200;

/** The object a row points at, when the row is a pointer. */
function pointee(row: unknown): string | undefined {
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

function checkedMaxBytes(maxBytes: number | undefined): number {
  const limit = maxBytes ?? DEFAULT_SPILL_BYTES;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error(`spillStorage: maxBytes must be a positive number, got ${limit}.`);
  }
  return limit;
}

//#endregion

//#region Factory

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
  const { blobs } = options;
  const maxBytes = checkedMaxBytes(options.maxBytes);
  const prefix = options.prefix ?? DEFAULT_PREFIX;

  /** Where `value` goes: the row itself, or a new object the row points at. */
  async function place(key: string, value: unknown): Promise<Placed> {
    const json = JSON.stringify(value);
    if (json === undefined || byteLength(json) <= maxBytes) {
      return {
        row: value,
      };
    }
    const object = `${prefix}/${key.slice(0, KEY_PART_LENGTH)}/${crypto.randomUUID()}`;
    await blobs.put(object, json);
    return {
      row: pointerTo(object),
      object,
    };
  }

  /**
   * Delete the object of a write that did not land. A write that landed but
   * reported failure left the row pointing at it, and it is kept.
   */
  async function unplace(key: string, object: string | undefined): Promise<void> {
    if (object === undefined) {
      return;
    }
    const row = await storage.get<unknown>(key).catch(() => null);
    if (pointee(row) !== object) {
      await blobs.delete(object);
    }
  }

  /** The text of the object `row` points at, or undefined when it is no pointer or the object is gone. */
  async function spilledText(row: unknown): Promise<string | undefined> {
    const object = pointee(row);
    const held = object === undefined ? null : await blobs.get(object);
    return held ? held.text() : undefined;
  }

  /**
   * The value a row stands for. A writer may delete an object between this
   * reader's row read and its object read, so a missing object means the row is
   * read again. One still missing behind an unchanged pointer is corruption, not
   * absence: reading it as absent would restart a turn from nothing.
   */
  async function resolve<T>(key: string, first: unknown): Promise<T | null> {
    let row = first;
    for (let attempt = 1; ; attempt++) {
      const object = pointee(row);
      if (object === undefined) {
        return typedCast<T>(row);
      }
      const text = await spilledText(row);
      if (text !== undefined) {
        return typedCast<T>(JSON.parse(text));
      }
      const again = await storage.get<unknown>(key);
      if (again === null) {
        return null;
      }
      if (pointee(again) === object || attempt >= READ_ATTEMPTS) {
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
  async function rowHolding(key: string, prev: unknown): Promise<unknown> {
    const json = JSON.stringify(prev);
    if (json === undefined || byteLength(json) <= maxBytes) {
      return prev;
    }
    const row = await storage.get<unknown>(key);
    if (pointee(row) === undefined) {
      return prev;
    }
    return (await spilledText(row)) === json ? row : undefined;
  }

  async function swapRows(key: string, held: unknown, placed: Placed): Promise<boolean> {
    const inner = storage.swap;
    if (!inner) {
      throw new Error('spillStorage: the storage underneath has no swap.');
    }
    try {
      return await inner.call(storage, key, held, placed.row);
    } catch (error) {
      // A swap that threw may still have landed, and the row then holds what this
      // call wrote: calling that a loss would tell a lease's holder it was replaced.
      const now = await storage.get<unknown>(key).catch(() => undefined);
      if (JSON.stringify(now) !== JSON.stringify(placed.row)) {
        await unplace(key, placed.object);
        throw error;
      }
      return true;
    }
  }

  async function swap<T>(key: string, prev: T | null, next: T): Promise<boolean> {
    let held: unknown = prev;
    if (prev !== null) {
      held = await rowHolding(key, prev);
      if (held === undefined) {
        return false;
      }
    }
    const placed = await place(key, next);
    let won = await swapRows(key, held, placed);
    if (!won && prev !== null && pointee(held) === undefined) {
      // `prev` was matched as a row value, and the key may hold it spilled instead:
      // written under a smaller `maxBytes`.
      const row = await storage.get<unknown>(key);
      if ((await spilledText(row)) === JSON.stringify(prev)) {
        held = row;
        won = await swapRows(key, held, placed);
      }
    }
    const stale = won ? pointee(held) : placed.object;
    if (stale !== undefined) {
      await blobs.delete(stale);
    }
    return won;
  }

  const spilling: StorageAdapter = {
    async get<T>(key: string): Promise<T | null> {
      const row = await storage.get<unknown>(key);
      return row === null ? null : resolve<T>(key, row);
    },
    async set<T>(key: string, value: T): Promise<void> {
      const placed = await place(key, value);
      let replaced: string | undefined;
      try {
        // Read first: the object this write replaces is deleted once it has landed.
        replaced = pointee(await storage.get<unknown>(key));
        await storage.set(key, placed.row);
      } catch (error) {
        await unplace(key, placed.object);
        throw error;
      }
      if (replaced !== undefined && replaced !== placed.object) {
        await blobs.delete(replaced);
      }
    },
    async delete(key: string): Promise<void> {
      const object = pointee(await storage.get<unknown>(key));
      await storage.delete(key);
      if (object !== undefined) {
        await blobs.delete(object);
      }
    },
    list: (prefixOfKeys: string) => storage.list(prefixOfKeys),
  };
  const getMany = storage.getMany;
  if (getMany) {
    spilling.getMany = async <T>(keys: string[]): Promise<Map<string, T>> => {
      const rows = await getMany.call(storage, keys);
      const found = new Map<string, T>();
      await Promise.all(
        [
          ...rows,
        ].map(async ([key, row]) => {
          const value = await resolve<T>(key, row);
          if (value !== null) {
            found.set(key, value);
          }
        }),
      );
      return found;
    };
  }
  if (storage.swap) {
    spilling.swap = swap;
  }
  return spilling;
}

/**
 * @internal `storage`, spilling when the factory was given `spill`. A scope is
 * added to the prefix, so two scopes' objects are apart as their rows are.
 */
export function withSpill(
  storage: StorageAdapter,
  spill: SpillOptions | undefined,
  scope: string | undefined,
): StorageAdapter {
  if (!spill) {
    return storage;
  }
  const prefix = spill.prefix ?? DEFAULT_PREFIX;
  return spillStorage(storage, {
    ...spill,
    prefix: scope === undefined ? prefix : `${prefix}/${scope}`,
  });
}

// Identity coercion at the storage boundary: the `StorageAdapter` contract hands
// the responsibility for `<T>` back to the caller, as the other adapters do.
function typedCast<T>(value: unknown): T {
  // @ts-expect-error — identity coercion at the storage boundary
  return value;
}

//#endregion
