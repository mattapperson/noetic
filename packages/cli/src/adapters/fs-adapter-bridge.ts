/**
 * Bridge between Noetic's FsAdapter and just-bash's IFileSystem interface.
 *
 * Delegates all filesystem operations to the FsAdapter so that emulated
 * shell commands see the same files as the framework.
 *
 * Limitations:
 * - stat/lstat return hardcoded mode (0o644) and current timestamp for mtime
 *   since FsStats does not expose these fields
 * - rm, cp, mv, symlink, link, readlink are not supported (FsAdapter lacks these ops)
 * - getAllPaths returns [] (glob expansion in just-bash falls back to readdir)
 */

import path from 'node:path';
import type { FsAdapter } from '@noetic/core';
import type { IFileSystem } from 'just-bash';

//#region Public API

/** Create a just-bash IFileSystem backed by a Noetic FsAdapter. */
export function createBridgedFs(fs: FsAdapter): IFileSystem {
  return {
    async readFile(p) {
      return fs.readFileText(p);
    },

    async readFileBuffer(p) {
      const buf = await fs.readFile(p);
      return new Uint8Array(buf);
    },

    async writeFile(p, content) {
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
      await fs.writeFile(p, text);
    },

    async appendFile(p, content) {
      const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
      await fs.appendFile(p, text);
    },

    async exists(p) {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    },

    async stat(p) {
      const s = await fs.stat(p);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        mode: 0o644,
        size: s.size,
        mtime: new Date(),
      };
    },

    async mkdir(p, options) {
      if (!options?.recursive) {
        // Non-recursive: verify parent exists before creating
        const parent = path.dirname(p);
        try {
          const parentStat = await fs.stat(parent);
          if (!parentStat.isDirectory()) {
            throw new Error(`ENOTDIR: not a directory, mkdir '${p}'`);
          }
        } catch {
          throw new Error(`ENOENT: no such file or directory, mkdir '${p}'`);
        }
      }
      await fs.mkdir(p);
    },

    async readdir(p) {
      return fs.readdir(p);
    },

    async rm() {
      throw new Error('rm not supported via FsAdapter bridge');
    },

    async cp() {
      throw new Error('cp not supported via FsAdapter bridge');
    },

    async mv() {
      throw new Error('mv not supported via FsAdapter bridge');
    },

    resolvePath(base, rel) {
      return path.resolve(base, rel);
    },

    getAllPaths() {
      return [];
    },

    async chmod() {
      // no-op: FsAdapter doesn't support chmod
    },

    async symlink() {
      throw new Error('symlink not supported via FsAdapter bridge');
    },

    async link() {
      throw new Error('link not supported via FsAdapter bridge');
    },

    async readlink() {
      throw new Error('readlink not supported via FsAdapter bridge');
    },

    async lstat(p) {
      const s = await fs.lstat(p);
      return {
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        mode: 0o644,
        size: s.size,
        mtime: new Date(),
      };
    },

    async realpath(p) {
      return path.resolve(p);
    },

    async utimes() {
      // no-op: FsAdapter doesn't support utimes
    },
  };
}

//#endregion
