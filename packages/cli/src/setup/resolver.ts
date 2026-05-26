/**
 * Resolve per-binary status from config + detector output.
 *
 * Ignore decisions come from two sources, unioned:
 *   1. The user-global sidecar at `~/.config/noetic/setup.json` — written by
 *      the setup-flow UI when the user chooses "Ignore".
 *   2. `config.setup.ignoredBinaries` inside a loaded `noetic.config.ts` —
 *      for users who want to check ignores into version control alongside
 *      their project config.
 *
 * Everything else is concurrent — the detectors spawn child processes for
 * the workspace-dep kind, so serial is noticeably slower.
 */

import type { AgentConfig } from '../types/config.js';
import type { BinaryDescriptor, BinaryStatus } from './types.js';
import { isBinaryId } from './types.js';
import { readUserSetup } from './user-config-writer.js';

export async function resolveBinaryStatuses(
  config: AgentConfig,
  manifest: ReadonlyArray<BinaryDescriptor>,
): Promise<ReadonlyArray<BinaryStatus>> {
  const userSetup = await readUserSetup();
  const ignored = new Set<string>();
  for (const id of userSetup.ignoredBinaries) {
    ignored.add(id);
  }
  for (const id of config.setup?.ignoredBinaries ?? []) {
    if (isBinaryId(id)) {
      ignored.add(id);
    }
  }

  const results = await Promise.all(
    manifest.map(async (descriptor): Promise<BinaryStatus> => {
      if (ignored.has(descriptor.id)) {
        return {
          id: descriptor.id,
          state: 'ignored',
        };
      }
      const present = await descriptor.detect();
      return {
        id: descriptor.id,
        state: present ? 'present' : 'missing',
      };
    }),
  );

  return results;
}
