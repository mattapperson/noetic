import { createLocalFsAdapter } from '@noetic/core';

import { defaultSignaller } from '../agent-ci-control.js';
import type { TaskStoreContext } from '../fs-store.js';
import type { AutopilotDeps } from './autopilot.js';

//#region Public API

/**
 * @public
 * Constructs the long-lived dependencies bag used by every hierarchy
 * daemon job (autopilot, validator, health). The TaskStoreContext binds
 * the FsAdapter to the project root; the Signaller covers process-level
 * pause/resume/abort and liveness checks. Unlike the legacy
 * `buildMissionDaemonDeps`, this no longer constructs an AgentHarness
 * here — daemon jobs that need an LLM build their own per-job harness
 * (cheap because skills are cached) so the bootstrap stays a pure data
 * pass-through.
 */
export function buildHierarchyDaemonDeps(projectRoot: string): AutopilotDeps {
  const ctx: TaskStoreContext = {
    fs: createLocalFsAdapter(),
    projectRoot,
  };
  return {
    ctx,
    signaller: defaultSignaller,
  };
}

//#endregion
