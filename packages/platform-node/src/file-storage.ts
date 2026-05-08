import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { StorageAdapter } from '@noetic/core';

// Private replica of core's internal `frameworkCast` — kept local here
// so the unsafe escape hatch does not become part of `@noetic/core`'s
// public API surface. This is NOT a "safer" pattern than exporting
// `frameworkCast`; it is the same identity coercion, just scoped to
// this file. `JSON.parse` returns `unknown` and the `StorageAdapter`
// contract hands the responsibility for `<T>` back to the caller —
// there is no schema at this boundary to validate against.
function typedCast<T>(value: unknown): T {
  // @ts-expect-error — identity coercion at the JSON.parse boundary
  return value;
}

//#region Key <-> path mapping

/**
 * Map arbitrary storage keys to filesystem-safe path fragments. Colons,
 * slashes, and other special chars are encoded so keys containing
 * `execution:<uuid>:frontier` round-trip to a single filename and back
 * without collisions.
 *
 * @internal
 */
const ENCODED_SEP = '__';

function encodeKey(key: string): string {
  // URI-encode to escape non-filesystem-safe chars, then replace "%" with
  // double-underscore so a decoded path still survives OS path delimiters.
  return encodeURIComponent(key).replace(/%/g, ENCODED_SEP);
}

function decodeKey(encoded: string): string {
  return decodeURIComponent(encoded.replaceAll(ENCODED_SEP, '%'));
}

function keyToPath(root: string, key: string): string {
  return path.join(root, `${encodeKey(key)}.json`);
}

function pathToKey(file: string): string | null {
  if (!file.endsWith('.json')) {
    return null;
  }
  const base = file.slice(0, -'.json'.length);
  try {
    return decodeKey(base);
  } catch {
    return null;
  }
}

//#endregion

//#region Factory

/** @public Options for `createFileStorage`. */
export interface CreateFileStorageOptions {
  /**
   * Absolute path to the root directory under which storage entries are
   * written. The directory is created on first use (including any missing
   * parent components). Defaults to `~/.noetic/checkpoints` when omitted.
   */
  root?: string;
}

function defaultRoot(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  return path.join(home, '.noetic', 'checkpoints');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, {
      recursive: true,
    });
  }
}

/**
 * @public
 * Create a file-backed `StorageAdapter` that writes each key to a JSON
 * file under the configured root directory. Designed to be the default
 * production-mode backing for checkpoint storage — the implementation is
 * synchronous under the hood to minimise partial-write risk on crash,
 * matching the expectation that checkpoint writes are small (kilobytes)
 * and infrequent relative to step execution.
 *
 * Not optimised for high-throughput workloads. If checkpoint volume
 * becomes a bottleneck, swap for a database-backed adapter.
 */
export function createFileStorage(options: CreateFileStorageOptions = {}): StorageAdapter {
  const root = options.root ?? defaultRoot();
  ensureDir(root);

  return {
    async get<T>(key: string): Promise<T | null> {
      const file = keyToPath(root, key);
      if (!existsSync(file)) {
        return null;
      }
      try {
        const raw = readFileSync(file, 'utf8');
        if (raw.length === 0) {
          return null;
        }
        const parsed = JSON.parse(raw);
        return typedCast<T>(parsed);
      } catch (err) {
        console.warn(`createFileStorage: failed to read "${key}":`, err);
        return null;
      }
    },
    async set<T>(key: string, value: T): Promise<void> {
      ensureDir(root);
      const file = keyToPath(root, key);
      const tmp = `${file}.tmp`;
      // Write via a .tmp sibling then rename — reduces the "half-written
      // file found on restart" window to the rename itself. On crash mid-
      // write the main file either still holds the previous value, or the
      // rename completed.
      writeFileSync(tmp, JSON.stringify(value));
      // `renameSync` is the atomic step on POSIX filesystems.
      renameSync(tmp, file);
    },
    async delete(key: string): Promise<void> {
      const file = keyToPath(root, key);
      if (!existsSync(file)) {
        return;
      }
      try {
        unlinkSync(file);
      } catch (err) {
        console.warn(`createFileStorage: failed to delete "${key}":`, err);
      }
    },
    async list(prefix: string): Promise<string[]> {
      if (!existsSync(root)) {
        return [];
      }
      const files = readdirSync(root);
      const out: string[] = [];
      for (const file of files) {
        const key = pathToKey(file);
        if (key?.startsWith(prefix)) {
          out.push(key);
        }
      }
      return out;
    },
  };
}

//#endregion
