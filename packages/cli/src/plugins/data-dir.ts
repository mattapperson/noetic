import { mkdirSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { StorageAdapter } from '@noetic/core';
import type { PluginStorageScope } from '@noetic/code-agent/plugins';
import { safePluginNameSegment } from '@noetic/code-agent/utils';

export type DataDirScope = PluginStorageScope;

export function createDataDir(cwd: string, pluginName: string): (scope: DataDirScope) => string {
  const segment = safePluginNameSegment(pluginName);
  return (scope) => {
    const base =
      scope === 'project' ? join(cwd, '.noetic', segment) : join(homedir(), '.noetic', segment);
    mkdirSync(base, {
      recursive: true,
    });
    return base;
  };
}

function encodeKey(key: string): string {
  return `${encodeURIComponent(key)}.json`;
}

export function createNodePluginStorage(
  cwd: string,
  pluginName: string,
  scope: PluginStorageScope,
): StorageAdapter {
  const dataDir = createDataDir(cwd, pluginName)(scope);
  return {
    async get<T>(key: string): Promise<T | null> {
      try {
        return JSON.parse(await readFile(join(dataDir, encodeKey(key)), 'utf8')) as T;
      } catch {
        return null;
      }
    },
    async set<T>(key: string, value: T): Promise<void> {
      const target = join(dataDir, encodeKey(key));
      await mkdir(dirname(target), {
        recursive: true,
      });
      await writeFile(target, JSON.stringify(value), 'utf8');
    },
    async delete(key: string): Promise<void> {
      await rm(join(dataDir, encodeKey(key)), {
        force: true,
      });
    },
    async list(prefix: string): Promise<string[]> {
      const entries = await readdir(dataDir).catch(() => []);
      return entries
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => decodeURIComponent(entry.slice(0, -'.json'.length)))
        .filter((key) => key.startsWith(prefix));
    },
  };
}
