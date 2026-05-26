import type { FsAdapter, FsStats } from '../types/fs-adapter';
import { frameworkCast } from '../util/framework-cast';

//#region Helpers

interface FileEntry {
  kind: 'file';
  bytes: Uint8Array;
}

interface DirEntry {
  kind: 'dir';
}

type Entry = FileEntry | DirEntry;

function normalizePath(path: string): string {
  const raw = path.trim();
  if (raw.length === 0) {
    return '/';
  }
  const absolute = raw.startsWith('/') ? raw : `/${raw}`;
  const parts: string[] = [];
  for (const part of absolute.split('/')) {
    if (part.length === 0 || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function parentPath(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') {
    return '/';
  }
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? '/' : normalized.slice(0, idx);
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === '/') {
    return '';
  }
  const idx = normalized.lastIndexOf('/');
  return normalized.slice(idx + 1);
}

function statsFor(entry: Entry): FsStats {
  return {
    size: entry.kind === 'file' ? entry.bytes.byteLength : 0,
    isDirectory: () => entry.kind === 'dir',
    isSymbolicLink: () => false,
    isFile: () => entry.kind === 'file',
  };
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return bytes.slice();
}

function toUint8Array(content: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content);
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
}

function asBuffer(bytes: Uint8Array): Buffer {
  const maybeBuffer = frameworkCast<
    typeof globalThis & {
      Buffer?: {
        from(input: Uint8Array): Buffer;
      };
    }
  >(globalThis);
  if (maybeBuffer.Buffer) {
    return maybeBuffer.Buffer.from(bytes);
  }
  return frameworkCast<Buffer>(cloneBytes(bytes));
}

function ensureDirSync(entries: Map<string, Entry>, path: string): void {
  const normalized = normalizePath(path);
  if (entries.has(normalized)) {
    const existing = entries.get(normalized)!;
    if (existing.kind !== 'dir') {
      throw new Error(`ENOTDIR: not a directory, mkdir '${normalized}'`);
    }
    return;
  }
  if (normalized !== '/') {
    ensureDirSync(entries, parentPath(normalized));
  }
  entries.set(normalized, {
    kind: 'dir',
  });
}

//#endregion

//#region Public API

/** @public Create a process-local, POSIX-like in-memory filesystem adapter. */
export function createInMemoryFsAdapter(seed?: Record<string, string | Uint8Array>): FsAdapter {
  const entries = new Map<string, Entry>([
    [
      '/',
      {
        kind: 'dir',
      },
    ],
  ]);

  async function ensureDir(path: string): Promise<void> {
    ensureDirSync(entries, path);
  }

  function requireEntry(path: string): Entry {
    const normalized = normalizePath(path);
    const entry = entries.get(normalized);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, '${normalized}'`);
    }
    return entry;
  }

  async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const normalized = normalizePath(path);
    await ensureDir(parentPath(normalized));
    entries.set(normalized, {
      kind: 'file',
      bytes: cloneBytes(bytes),
    });
  }

  const adapter: FsAdapter = {
    async readFile(path) {
      const entry = requireEntry(path);
      if (entry.kind !== 'file') {
        throw new Error(`EISDIR: illegal operation on a directory, read '${normalizePath(path)}'`);
      }
      return asBuffer(entry.bytes);
    },
    async readFileText(path) {
      const entry = requireEntry(path);
      if (entry.kind !== 'file') {
        throw new Error(`EISDIR: illegal operation on a directory, read '${normalizePath(path)}'`);
      }
      return new TextDecoder().decode(entry.bytes);
    },
    async writeFile(path, content) {
      await writeBytes(path, new TextEncoder().encode(content));
    },
    async writeFileBytes(path, content) {
      await writeBytes(path, toUint8Array(content));
    },
    async appendFile(path, content) {
      const normalized = normalizePath(path);
      const next = new TextEncoder().encode(content);
      const current = entries.get(normalized);
      if (!current) {
        await writeBytes(normalized, next);
        return;
      }
      if (current.kind !== 'file') {
        throw new Error(`EISDIR: illegal operation on a directory, append '${normalized}'`);
      }
      const combined = new Uint8Array(current.bytes.byteLength + next.byteLength);
      combined.set(current.bytes);
      combined.set(next, current.bytes.byteLength);
      entries.set(normalized, {
        kind: 'file',
        bytes: combined,
      });
    },
    mkdir: ensureDir,
    async rename(oldPath, newPath) {
      const oldNormalized = normalizePath(oldPath);
      const newNormalized = normalizePath(newPath);
      const entry = requireEntry(oldNormalized);
      await ensureDir(parentPath(newNormalized));
      entries.set(
        newNormalized,
        entry.kind === 'file'
          ? {
              ...entry,
              bytes: cloneBytes(entry.bytes),
            }
          : entry,
      );
      entries.delete(oldNormalized);
      if (entry.kind === 'dir') {
        for (const [path, child] of [
          ...entries,
        ]) {
          if (path.startsWith(`${oldNormalized}/`)) {
            const moved = `${newNormalized}${path.slice(oldNormalized.length)}`;
            entries.set(
              moved,
              child.kind === 'file'
                ? {
                    ...child,
                    bytes: cloneBytes(child.bytes),
                  }
                : child,
            );
            entries.delete(path);
          }
        }
      }
    },
    async rm(path, options) {
      const normalized = normalizePath(path);
      const entry = entries.get(normalized);
      if (!entry) {
        if (options?.force) {
          return;
        }
        throw new Error(`ENOENT: no such file or directory, rm '${normalized}'`);
      }
      if (entry.kind === 'dir') {
        const children = [
          ...entries.keys(),
        ].filter((p) => p.startsWith(`${normalized}/`));
        if (children.length > 0 && !options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty, rm '${normalized}'`);
        }
        for (const child of children) {
          entries.delete(child);
        }
      }
      if (normalized !== '/') {
        entries.delete(normalized);
      }
    },
    async access(path) {
      requireEntry(path);
    },
    async stat(path) {
      return statsFor(requireEntry(path));
    },
    async lstat(path) {
      return statsFor(requireEntry(path));
    },
    async readdir(path) {
      const normalized = normalizePath(path);
      const entry = requireEntry(normalized);
      if (entry.kind !== 'dir') {
        throw new Error(`ENOTDIR: not a directory, scandir '${normalized}'`);
      }
      const prefix = normalized === '/' ? '/' : `${normalized}/`;
      const names = new Set<string>();
      for (const key of entries.keys()) {
        if (key === normalized || !key.startsWith(prefix)) {
          continue;
        }
        const rest = key.slice(prefix.length);
        if (rest.length > 0 && !rest.includes('/')) {
          names.add(basename(key));
        }
      }
      return [
        ...names,
      ].sort();
    },
  };

  for (const [path, content] of Object.entries(seed ?? {})) {
    ensureDirSync(entries, parentPath(path));
    entries.set(normalizePath(path), {
      kind: 'file',
      bytes: toUint8Array(content),
    });
  }

  return adapter;
}

//#endregion
