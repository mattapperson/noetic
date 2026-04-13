import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import type { FsAdapter, FsStats } from '../types/fs-adapter';

//#region Helpers

function toFsStats(s: {
  size: number;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  isFile: () => boolean;
}): FsStats {
  return {
    size: s.size,
    isDirectory: () => s.isDirectory(),
    isSymbolicLink: () => s.isSymbolicLink(),
    isFile: () => s.isFile(),
  };
}

//#endregion

//#region Public API

/** Create an FsAdapter backed by the local filesystem via `node:fs/promises`. */
export function createLocalFsAdapter(): FsAdapter {
  return {
    readFile: (p) => fs.readFile(p),
    readFileText: (p) => fs.readFile(p, 'utf-8'),
    writeFile: (p, content) => fs.writeFile(p, content, 'utf-8'),
    mkdir: async (dir) => {
      await fs.mkdir(dir, {
        recursive: true,
      });
    },
    access: (p, mode) => fs.access(p, mode ?? constants.R_OK),
    stat: async (p) => toFsStats(await fs.stat(p)),
    lstat: async (p) => toFsStats(await fs.lstat(p)),
    readdir: (p) => fs.readdir(p),
  };
}

//#endregion
