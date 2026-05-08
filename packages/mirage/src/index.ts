import type { FsAdapter, ShellAdapter } from '@noetic/core';
import { createMirageFsAdapter } from './fs-adapter';
import { createMirageShellAdapter } from './shell-adapter';
import type { MirageAdaptersOpts, MirageWorkspace } from './types';

/** @public Result of `createMirageAdapters`. */
export interface MirageAdapters {
  readonly fs: FsAdapter;
  readonly shell: ShellAdapter;
  readonly workspace: MirageWorkspace;
  /** Preferred initial cwd for a harness constructed with these adapters. */
  readonly defaultCwd: string;
}

/**
 * Construct a paired `FsAdapter` + `ShellAdapter` backed by a Mirage
 * Workspace. The caller constructs the concrete `Workspace` from
 * `@struktoai/mirage-node` (Node.js runtimes) or
 * `@struktoai/mirage-browser` (browser / edge runtimes) and passes it
 * in — both are declared as optional peer dependencies of
 * `@noetic/mirage`, so harnesses that never call this factory pay
 * nothing for them.
 *
 * See `specs/24-mirage-resources.md` for the full contract.
 *
 * @public
 */
export function createMirageAdapters(opts: MirageAdaptersOpts): MirageAdapters {
  const { workspace, defaultCwd = '/' } = opts;
  return {
    fs: createMirageFsAdapter(workspace),
    shell: createMirageShellAdapter(workspace),
    workspace,
    defaultCwd,
  };
}

export { isMirageError, MirageError, type MirageErrorKind } from './errors';
export type {
  MirageAdaptersOpts,
  MirageExecuteOptions,
  MirageExecuteResult,
  MirageWorkspace,
} from './types';
