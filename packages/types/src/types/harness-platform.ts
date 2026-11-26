import type { AdapterConfig, AdapterSet } from './adapter-set';
import { adapterSet } from './adapter-set';
import type { CwdState } from './context';
import type { FsAdapter } from './fs-adapter';
import type { ShellAdapter } from './shell-adapter';
import type { SubprocessAdapter } from './subprocess-adapter';

/** @public A harness's filesystem, shell and subprocess adapters, each kind by name. */
export interface AdapterSets {
  readonly fs: AdapterSet<FsAdapter>;
  readonly shell: AdapterSet<ShellAdapter>;
  readonly subprocess: AdapterSet<SubprocessAdapter>;
}

/**
 * @public The platform surface a harness runs on: its filesystem, shell, and
 * subprocess adapters plus the root cwd its contexts start in. Shared by
 * `AgentHarnessContract` and the `ContextHarness` view of it.
 */
export interface HarnessPlatform {
  /** The default filesystem adapter. */
  readonly fs: FsAdapter;
  /** The default shell adapter. */
  readonly shell: ShellAdapter;
  /** The default subprocess adapter. */
  readonly subprocess: SubprocessAdapter;
  /** Every filesystem, shell and subprocess adapter, by name. */
  readonly adapters: AdapterSets;
  /** Long-lived shared cwd state seeded into root contexts created by this harness. */
  readonly rootCwdState: CwdState;
  /** Update the harness root cwd. Used by the TUI when the user issues a `! cd`. */
  setRootCwd(nextCwd: string): void;
}

/**
 * @public
 * Builds a harness's {@link AdapterSets} from what its environment configures
 * for each kind: one adapter, or several by name.
 *
 * @throws `NoeticConfigError` for a malformed set (see {@link adapterSet}).
 */
export function adapterSets(config: {
  fs: AdapterConfig<FsAdapter>;
  shell: AdapterConfig<ShellAdapter>;
  subprocess: AdapterConfig<SubprocessAdapter>;
}): AdapterSets {
  return {
    fs: adapterSet({
      kind: 'fs',
      config: config.fs,
      method: 'readFile',
    }),
    shell: adapterSet({
      kind: 'shell',
      config: config.shell,
      method: 'exec',
    }),
    subprocess: adapterSet({
      kind: 'subprocess',
      config: config.subprocess,
      method: 'spawn',
    }),
  };
}
