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
  const keyPartBytes = Math.min(
    KEY_PART_BYTES,
    OBJECT_KEY_BYTES - byteLength(prefix) - OBJECT_SUFFIX_BYTES,
  );
  if (keyPartBytes < 1) {
    throw new Error(
      `spillStorage: prefix "${prefix}" leaves no room in an object key; keep it under ${OBJECT_KEY_BYTES - OBJECT_SUFFIX_BYTES - 1} bytes.`,
    );
  }
  const followed = [
    `${prefix}/`,
    ...(options.movedPrefixes ?? []),
  ];

  /** The object a row points at, when it is a pointer this storage made or was told to follow. */
  function pointee(row: unknown): string | undefined {
    const object = pointerIn(row);
    return object !== undefined && followed.some((start) => object.startsWith(start))
      ? object
      : undefined;
  }

  /** Where `value` goes: the row itself, or a new object the row points at. */
  async function place(key: string, value: unknown): Promise<Placed> {
    if (pointerIn(value) !== undefined) {
      throw new Error(
        `spillStorage: "${key}" cannot hold a value whose only key is "${POINTER_KEY}": it would be read as a pointer.`,
      );
    }
    const json = JSON.stringify(value);
    if (json === undefined || byteLength(json) <= maxBytes) {
      return {
        row: value,
      };
    }
    const object = `${prefix}/${cutToBytes(key, keyPartBytes)}/${crypto.randomUUID()}`;
    await blobs.put(object, json);
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
  async function unplace(key: string, object: string | undefined): Promise<void> {
    if (object === undefined) {
      return;
    }
    let row: unknown;
    try {
      row = await storage.get<unknown>(key);
    } catch {
      return;
    }
    if (pointee(row) !== object) {
      await dropObject(blobs, object);
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
      let now: unknown;
      try {
        now = await storage.get<unknown>(key);
      } catch {
        // Cannot tell whether it landed: keep the object, and report the failure.
        throw error;
      }
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
      await dropObject(blobs, stale);
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
        await dropObject(blobs, replaced);
      }
    },
    async delete(key: string): Promise<void> {
      const object = pointee(await storage.get<unknown>(key));
      await storage.delete(key);
      if (object !== undefined) {
        await dropObject(blobs, object);
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
