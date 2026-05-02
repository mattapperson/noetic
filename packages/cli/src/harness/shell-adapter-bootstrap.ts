import type { LocalShellAdapter } from '@noetic/core';
import { createLocalShellAdapter, NoeticConfigError } from '@noetic/core';
import type { AgentConfig } from '../types/config.js';

/**
 * Construct the default `ShellAdapter` for a harness, honoring `config.shell`.
 *
 * `config.shell.useRtk` (default `true`) wraps every command through
 * `rtk rewrite` for token-efficient output. When wrapping is requested but
 * `rtk` is not on PATH, we fail fast with install instructions — silently
 * falling through to raw `sh -c` would produce huge model context bills
 * with no warning.
 *
 * Set `shell.useRtk: false` in `noetic.config.ts` to opt out.
 */
export function createDefaultShellAdapter(config: AgentConfig): LocalShellAdapter {
  const useRtk = config.shell?.useRtk ?? true;
  const adapter = createLocalShellAdapter({
    useRtk,
  });

  if (useRtk && !adapter.rtkAvailable) {
    throw new NoeticConfigError({
      code: 'RTK_NOT_FOUND',
      message:
        'shell.useRtk is enabled but `rtk` was not found on PATH. ' +
        'rtk filters and summarizes shell output to keep model context costs down.',
      hint:
        'Install rtk via one of:\n' +
        '  brew install rtk\n' +
        '  cargo install --git https://github.com/rtk-ai/rtk\n' +
        '  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh\n' +
        '\n' +
        'Or set `shell: { useRtk: false }` in noetic.config.ts to opt out.',
      docsUrl: 'https://github.com/rtk-ai/rtk',
    });
  }

  return adapter;
}
