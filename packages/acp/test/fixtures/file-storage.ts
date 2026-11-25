/**
 * A StorageAdapter over a directory, one JSON file per key: enough for two
 * processes to share a durable run in a test.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StorageAdapter } from '@noetic-tools/types';

function fileOf(dir: string, key: string): string {
  return join(dir, `${encodeURIComponent(key)}.json`);
}

export function fileStorage(dir: string): StorageAdapter {
  mkdirSync(dir, {
    recursive: true,
  });
  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        return JSON.parse(readFileSync(fileOf(dir, key), 'utf8'));
      } catch {
        return null;
      }
    },
    async set<T>(key: string, value: T): Promise<void> {
      writeFileSync(fileOf(dir, key), JSON.stringify(value));
    },
    async delete(key: string): Promise<void> {
      rmSync(fileOf(dir, key), {
        force: true,
      });
    },
    async list(prefix: string): Promise<string[]> {
      return readdirSync(dir)
        .map((name) => decodeURIComponent(name.replace(/\.json$/, '')))
        .filter((key) => key.startsWith(prefix));
    },
  };
}
