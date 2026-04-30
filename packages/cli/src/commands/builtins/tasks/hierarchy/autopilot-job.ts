import type { JobDefinition } from '../../../../daemon-runtime/jobs.js';
import type { AutopilotDeps } from './autopilot.js';
import { runAutopilotTick } from './autopilot.js';

const AUTOPILOT_TICK_INTERVAL_MS = 60_000;

/** Daemon job that drives the per-task autopilot state machine. */
export function tasksAutopilotPollJob(deps: AutopilotDeps): JobDefinition {
  return {
    id: 'tasks.autopilot.poll',
    intervalMs: AUTOPILOT_TICK_INTERVAL_MS,
    runOnStart: true,
    run: async () => {
      await runAutopilotTick(deps);
    },
  };
}
