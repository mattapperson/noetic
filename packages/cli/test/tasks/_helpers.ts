import path from 'node:path';

import type { FsAdapter, FsStats } from '@noetic/core';

//#region Stat helper

interface StatLite {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

function toStats(s: StatLite): FsStats {
  return {
    size: s.size,
    isFile: () => s.isFile,
    isDirectory: () => s.isDirectory,
    isSymbolicLink: () => s.isSymbolicLink,
  };
}

function makeEnoent(
  operation: string,
  target: string,
): Error & {
  code: 'ENOENT';
} {
  const err = new Error(`ENOENT: no such file or directory, ${operation} '${target}'`);
  Object.assign(err, {
    code: 'ENOENT',
  });
  return Object.assign(err, {
    code: 'ENOENT' as const,
  });
}

//#endregion

//#region MemFs

/**
 * In-memory `FsAdapter` for hermetic tests of the FS-backed task store.
 * Stores file contents as Buffers so binary writes (`writeFileBytes`)
 * round-trip cleanly; text helpers decode UTF-8 on read.
 */
export class MemFs implements FsAdapter {
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>();

  constructor(
    seedDirs: ReadonlyArray<string> = [
      '/',
    ],
  ) {
    for (const d of seedDirs) {
      this.ensureDir(d);
    }
  }

  private ensureDir(dir: string): void {
    let cur = path.resolve(dir);
    while (cur.length > 0) {
      this.dirs.add(cur);
      const parent = path.dirname(cur);
      if (parent === cur) {
        break;
      }
      cur = parent;
    }
  }

  private parentExists(target: string): boolean {
    return this.dirs.has(path.dirname(path.resolve(target)));
  }

  async readFile(p: string): Promise<Buffer> {
    const buf = this.files.get(path.resolve(p));
    if (buf === undefined) {
      throw makeEnoent('open', p);
    }
    return buf;
  }

  async readFileText(p: string): Promise<string> {
    const buf = this.files.get(path.resolve(p));
    if (buf === undefined) {
      throw makeEnoent('open', p);
    }
    return buf.toString('utf-8');
  }

  async writeFile(p: string, content: string): Promise<void> {
    const abs = path.resolve(p);
    if (!this.parentExists(abs)) {
      throw makeEnoent('open', p);
    }
    this.files.set(abs, Buffer.from(content, 'utf-8'));
  }

  async writeFileBytes(p: string, content: Buffer): Promise<void> {
    const abs = path.resolve(p);
    if (!this.parentExists(abs)) {
      throw makeEnoent('open', p);
    }
    this.files.set(abs, Buffer.from(content));
  }

  async appendFile(p: string, content: string): Promise<void> {
    const abs = path.resolve(p);
    if (!this.parentExists(abs)) {
      throw makeEnoent('open', p);
    }
    const prev = this.files.get(abs) ?? Buffer.alloc(0);
    this.files.set(
      abs,
      Buffer.concat([
        prev,
        Buffer.from(content, 'utf-8'),
      ]),
    );
  }

  async mkdir(dir: string): Promise<void> {
    this.ensureDir(dir);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const oldAbs = path.resolve(oldPath);
    const newAbs = path.resolve(newPath);
    if (this.files.has(oldAbs)) {
      const content = this.files.get(oldAbs);
      if (content === undefined) {
        throw makeEnoent('rename', oldPath);
      }
      this.files.delete(oldAbs);
      this.files.set(newAbs, content);
      return;
    }
    if (this.dirs.has(oldAbs)) {
      this.dirs.delete(oldAbs);
      this.ensureDir(newAbs);
      // Move any nested files and dirs.
      const prefix = `${oldAbs}/`;
      for (const [filePath, content] of [
        ...this.files.entries(),
      ]) {
        if (filePath.startsWith(prefix)) {
          this.files.delete(filePath);
          this.files.set(newAbs + filePath.slice(oldAbs.length), content);
        }
      }
      for (const d of [
        ...this.dirs,
      ]) {
        if (d.startsWith(prefix)) {
          this.dirs.delete(d);
          this.dirs.add(newAbs + d.slice(oldAbs.length));
        }
      }
      return;
    }
    throw makeEnoent('rename', oldPath);
  }

  async rm(
    p: string,
    options?: {
      recursive?: boolean;
      force?: boolean;
    },
  ): Promise<void> {
    const abs = path.resolve(p);
    if (this.files.has(abs)) {
      this.files.delete(abs);
      return;
    }
    if (this.dirs.has(abs)) {
      if (!options?.recursive) {
        throw new Error(`EISDIR: illegal operation on directory: ${p}`);
      }
      const prefix = `${abs}/`;
      for (const filePath of [
        ...this.files.keys(),
      ]) {
        if (filePath === abs || filePath.startsWith(prefix)) {
          this.files.delete(filePath);
        }
      }
      for (const d of [
        ...this.dirs,
      ]) {
        if (d === abs || d.startsWith(prefix)) {
          this.dirs.delete(d);
        }
      }
      return;
    }
    if (options?.force) {
      return;
    }
    throw makeEnoent('rm', p);
  }

  async access(p: string): Promise<void> {
    const abs = path.resolve(p);
    if (this.files.has(abs) || this.dirs.has(abs)) {
      return;
    }
    throw makeEnoent('access', p);
  }

  async stat(p: string): Promise<FsStats> {
    const abs = path.resolve(p);
    const buf = this.files.get(abs);
    if (buf !== undefined) {
      return toStats({
        size: buf.byteLength,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
      });
    }
    if (this.dirs.has(abs)) {
      return toStats({
        size: 0,
        isFile: false,
        isDirectory: true,
        isSymbolicLink: false,
      });
    }
    throw makeEnoent('stat', p);
  }

  async lstat(p: string): Promise<FsStats> {
    return this.stat(p);
  }

  async readdir(p: string): Promise<string[]> {
    const abs = path.resolve(p);
    if (!this.dirs.has(abs)) {
      throw makeEnoent('readdir', p);
    }
    const prefix = abs.endsWith('/') ? abs : `${abs}/`;
    const entries = new Set<string>();
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        const name = rest.split('/')[0];
        if (name !== undefined && name.length > 0) {
          entries.add(name);
        }
      }
    }
    for (const d of this.dirs) {
      if (d.startsWith(prefix) && d !== abs) {
        const rest = d.slice(prefix.length);
        const name = rest.split('/')[0];
        if (name !== undefined && name.length > 0) {
          entries.add(name);
        }
      }
    }
    return Array.from(entries);
  }
}

//#endregion

//#region Helpers

/** Build a fresh in-memory store context rooted at `/repo`. */
export function makeStoreContext(projectRoot = '/repo'): {
  fs: MemFs;
  projectRoot: string;
} {
  const fs = new MemFs([
    projectRoot,
  ]);
  return {
    fs,
    projectRoot,
  };
}

//#endregion
