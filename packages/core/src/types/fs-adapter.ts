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
  /**
   * Append string content to a file (UTF-8). Creates the file if it does
   * not exist. On POSIX, the underlying write uses `O_APPEND`, which is
   * atomic for sub-`PIPE_BUF` writes — multiple concurrent writers can
   * append without interleaving as long as each call's payload stays
   * under that ceiling (4 KiB on Linux/macOS).
   */
  appendFile(path: string, content: string): Promise<void>;
  /** Create directories recursively. */
  mkdir(dir: string): Promise<void>;
  /**
   * Atomically rename a file or directory. On POSIX, this is the atomic
   * swap used by write-temp + rename to publish a new file version
   * without exposing readers to a half-written state.
   */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Remove a file or directory. With `recursive: true`, removes a directory tree. */
  rm(
    path: string,
    options?: {
      recursive?: boolean;
      force?: boolean;
    },
  ): Promise<void>;
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
