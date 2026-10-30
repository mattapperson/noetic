import type { CwdState } from './context';
import type { FsAdapter } from './fs-adapter';
import type { ShellAdapter } from './shell-adapter';
import type { SubprocessAdapter } from './subprocess-adapter';

/**
 * @public The platform surface a harness runs on: its filesystem, shell, and
 * subprocess adapters plus the root cwd its contexts start in. Shared by
 * `AgentHarnessContract` and the `ContextHarness` view of it.
 */
export interface HarnessPlatform {
  /** Filesystem adapter for virtual or real filesystem access. */
  readonly fs: FsAdapter;
  /** Shell adapter for virtual or real shell command execution. */
  readonly shell: ShellAdapter;
  /** Subprocess adapter for virtual, same-process, or host process execution. */
  readonly subprocess: SubprocessAdapter;
  /** Long-lived shared cwd state seeded into root contexts created by this harness. */
  readonly rootCwdState: CwdState;
  /** Update the harness root cwd. Used by the TUI when the user issues a `! cd`. */
  setRootCwd(nextCwd: string): void;
}
