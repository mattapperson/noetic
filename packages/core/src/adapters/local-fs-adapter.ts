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
  const fs = () => import('node:fs/promises');
  const fsConstants = () => import('node:fs');
  return {
    readFile: async (p) => (await fs()).readFile(p),
    readFileText: async (p) => (await fs()).readFile(p, 'utf-8'),
    writeFile: async (p, content) => (await fs()).writeFile(p, content, 'utf-8'),
    writeFileBytes: async (p, content) => (await fs()).writeFile(p, content),
    appendFile: async (p, content) => (await fs()).appendFile(p, content, 'utf-8'),
    mkdir: async (dir) => {
      await (await fs()).mkdir(dir, {
        recursive: true,
      });
    },
    rename: async (oldPath, newPath) => (await fs()).rename(oldPath, newPath),
    rm: async (p, options) => {
      await (await fs()).rm(p, options);
    },
    access: async (p, mode) => {
      const [{ constants }, fsPromises] = await Promise.all([
        fsConstants(),
        fs(),
      ]);
      await fsPromises.access(p, mode ?? constants.R_OK);
    },
    stat: async (p) => toFsStats(await (await fs()).stat(p)),
    lstat: async (p) => toFsStats(await (await fs()).lstat(p)),
    readdir: async (p) => (await fs()).readdir(p),
  };
}

//#endregion
