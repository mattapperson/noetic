/**
 * Nearest-root walker. Given an absolute file path and a list of root markers
 * (e.g. `package.json`, `go.mod`), walk up the directory tree until we find a
 * directory containing one of the markers. Returns null if we reach the
 * filesystem root without finding one — callers should fall back to cwd.
 */

import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

import type { FsAdapter } from '@noetic/core';

//#region Helpers

function isFilesystemRoot(currentDir: string): boolean {
  return currentDir === parse(currentDir).root;
}

async function directoryContainsAnyMarker(
  fs: FsAdapter,
  dir: string,
  markers: ReadonlyArray<string>,
): Promise<boolean> {
  for (const marker of markers) {
    const candidate = join(dir, marker);
    try {
      await fs.access(candidate);
      return true;
    } catch {
      // marker absent — try the next one
    }
  }
  return false;
}

//#endregion

//#region Public API

/**
 * Walk up from `fromFile`'s directory looking for a directory that contains
 * any of the `rootMarkers`. Returns the first match (nearest ancestor). Returns
 * null if none found before hitting the filesystem root.
 */
export async function findNearestRoot(
  fs: FsAdapter,
  fromFile: string,
  rootMarkers: ReadonlyArray<string>,
): Promise<string | null> {
  if (rootMarkers.length === 0) {
    return null;
  }
  let currentDir = dirname(fromFile);
  while (true) {
    if (await directoryContainsAnyMarker(fs, currentDir, rootMarkers)) {
      return currentDir;
    }
    if (isFilesystemRoot(currentDir)) {
      return null;
    }
    currentDir = dirname(currentDir);
  }
}

/**
 * Synchronous PATH-style fallback using the Node built-in `existsSync`.
 * Used in contexts where we can't await (e.g. the installer's which-check
 * for `bunx`-on-path).
 */
export function findNearestRootSync(
  fromFile: string,
  rootMarkers: ReadonlyArray<string>,
): string | null {
  if (rootMarkers.length === 0) {
    return null;
  }
  let currentDir = dirname(fromFile);
  while (true) {
    for (const marker of rootMarkers) {
      if (existsSync(join(currentDir, marker))) {
        return currentDir;
      }
    }
    if (isFilesystemRoot(currentDir)) {
      return null;
    }
    currentDir = dirname(currentDir);
  }
}

//#endregion
