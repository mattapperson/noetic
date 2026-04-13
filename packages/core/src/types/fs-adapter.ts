//#region Types

/** @public Minimal stat result returned by the filesystem adapter. */
export interface FsStats {
  size: number;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isFile(): boolean;
}

/** @public Filesystem abstraction for agent runtime operations. */
export interface FsAdapter {
  /** Read file contents as a Buffer. */
  readFile(path: string): Promise<Buffer>;
  /** Read file contents as a UTF-8 string. */
  readFileText(path: string): Promise<string>;
  /** Write string content to a file (UTF-8). */
  writeFile(path: string, content: string): Promise<void>;
  /** Create directories recursively. */
  mkdir(dir: string): Promise<void>;
  /** Check file accessibility (throws on failure). */
  access(path: string, mode?: number): Promise<void>;
  /** Get file/directory stats (follows symlinks). */
  stat(path: string): Promise<FsStats>;
  /** Get file/directory stats (does NOT follow symlinks). */
  lstat(path: string): Promise<FsStats>;
  /** Read directory entries (file names). */
  readdir(path: string): Promise<string[]>;
}

//#endregion
