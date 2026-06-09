import type { LocalShellAdapter } from '@noetic-tools/platform-node';
import { createLocalShellAdapter } from '@noetic-tools/platform-node';
import type { AgentConfig } from '../types/config.js';

//#region Types

export interface ShellAdapterOptions {
  /**
   * When `true`, rtk is treated as unavailable even if on PATH — the user
   * chose to ignore it via the setup flow. Forces `useRtk: false` so the
   * adapter runs raw `sh -c` without attempting rtk lookups.
   */
  rtkIgnored?: boolean;
}

//#endregion

//#region Public API

/**
 * Construct the default `ShellAdapter` for a harness, honoring `config.shell`.
 *
 * `config.shell.useRtk` (default `true`) prefers wrapping every command
 * through `rtk rewrite` for token-efficient output. When rtk is missing the
 * adapter falls back to raw `sh -c` — no warning is emitted from this layer.
 * The CLI's interactive setup flow (see `cli/run-setup-flow.tsx`) is the
 * single point where missing-binary UX lives; non-CLI embedders can inspect
 * `adapter.rtkAvailable` and render their own notice.
 *
 * If the caller passes `{ rtkIgnored: true }`, `useRtk` is forced to `false`
 * regardless of the config — the user explicitly opted out of rtk.
 */
export function createDefaultShellAdapter(
  config: AgentConfig,
  opts: ShellAdapterOptions = {},
): LocalShellAdapter {
  const useRtk = opts.rtkIgnored ? false : (config.shell?.useRtk ?? true);
  return createLocalShellAdapter({
    useRtk,
  });
}

//#endregion
