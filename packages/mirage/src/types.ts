/**
 * Structural type for the minimal Mirage Workspace surface our adapters
 * depend on. We do NOT import `@struktoai/mirage-node` at compile time —
 * it is an optional peer dependency. Consumers build the concrete
 * `Workspace` from their runtime's package and pass it in.
 *
 * This contract is deliberately narrow: `execute(cmd, options?) → Promise<Result>`
 * is the only entry point Mirage guarantees publicly today. When Mirage
 * exposes direct file/stat APIs, we widen this type and bypass the shell
 * for hot paths.
 */

/** @public Options forwarded to `workspace.execute`. */
export interface MirageExecuteOptions {
  /** VFS cwd the command is evaluated against (a mount path like `/local`). */
  cwd?: string;
  /** Environment variables forwarded to each per-mount handler. */
  env?: Record<string, string | undefined>;
  /** Optional stdin content. */
  stdin?: string;
  /** Abort the command mid-execution. */
  signal?: AbortSignal;
}

/** @public Result of `workspace.execute`. */
export interface MirageExecuteResult {
  /**
   * Stdout as bytes. Mirage's surface uses `Uint8Array`; our `FsAdapter`
   * methods decode to `Buffer` / string at the boundary.
   */
  stdout: Uint8Array;
  /** Stderr as bytes. */
  stderr: Uint8Array;
  /** POSIX-style exit code. `null` when killed by signal / timeout. */
  exitCode: number | null;
}

/** @public Minimal Workspace surface consumed by `createMirageAdapters`. */
export interface MirageWorkspace {
  execute(command: string, options?: MirageExecuteOptions): Promise<MirageExecuteResult>;
}

/** @public Options for `createMirageAdapters`. */
export interface MirageAdaptersOpts {
  workspace: MirageWorkspace;
  /** Initial VFS cwd. Falls back to `/` when omitted. */
  defaultCwd?: string;
}
