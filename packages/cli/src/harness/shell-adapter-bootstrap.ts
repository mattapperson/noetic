import type { LocalShellAdapter } from '@noetic/core';
import { createLocalShellAdapter } from '@noetic/core';
import type { AgentConfig } from '../types/config.js';

/**
 * One-time warning guard: we want each process to see the "rtk missing" hint
 * exactly once, not on every harness recreation (/model, /plan swaps each
 * build a fresh harness).
 */
let rtkMissingWarned = false;

function warnRtkMissing(): void {
  if (rtkMissingWarned) {
    return;
  }
  rtkMissingWarned = true;
  process.stderr.write(
    '[noetic] rtk not found on PATH — falling back to raw shell. ' +
      'rtk filters and summarizes shell output to keep model context costs down.\n' +
      '  Install for token efficiency:\n' +
      '    brew install rtk\n' +
      '    cargo install --git https://github.com/rtk-ai/rtk\n' +
      '    curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh\n' +
      '  Or set `shell: { useRtk: false }` in noetic.config.ts to silence this warning.\n',
  );
}

/**
 * Construct the default `ShellAdapter` for a harness, honoring `config.shell`.
 *
 * `config.shell.useRtk` (default `true`) prefers wrapping every command
 * through `rtk rewrite` for token-efficient output. The adapter handles the
 * "rtk missing" case internally by running raw `sh -c` — this bootstrap
 * layer exists only to surface a clear one-time warning so users aren't
 * silently paying for full unfiltered command output.
 *
 * Environments that cannot host rtk (Cloudflare Workers, sandboxed runtimes,
 * CI without the binary) get raw shell behavior automatically. Set
 * `shell: { useRtk: false }` to silence the warning and keep raw semantics.
 */
export function createDefaultShellAdapter(config: AgentConfig): LocalShellAdapter {
  const useRtk = config.shell?.useRtk ?? true;
  const adapter = createLocalShellAdapter({
    useRtk,
  });

  if (useRtk && !adapter.rtkAvailable) {
    warnRtkMissing();
  }

  return adapter;
}
