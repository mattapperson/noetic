/**
 * `/mission activate-slice <sliceId>` — flip a slice to `active` and ensure the daemon
 * is running so autopilot picks it up.
 */

import { ensureDaemon } from '../../../../../daemon-runtime/runtime.js';
import { activateSlice } from '../store.js';

export interface ActivateSliceDeps {
  ensureDaemonFn?: (cwd: string) => void;
}

export async function runMissionActivateSlice(
  cwd: string,
  argText: string,
  deps: ActivateSliceDeps = {},
): Promise<string> {
  const sliceId = argText.trim();
  if (sliceId.length === 0) {
    return 'Usage: /mission activate-slice <sliceId>';
  }
  const ensureDaemonFn = deps.ensureDaemonFn ?? ensureDaemon;
  try {
    activateSlice(cwd, sliceId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `activate-slice failed: ${message}`;
  }
  ensureDaemonFn(cwd);
  return `Activated slice ${sliceId}. Daemon ensured.`;
}
