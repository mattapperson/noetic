import type { JobDefinition } from '../../../../daemon-runtime/jobs.js';
import type { AutopilotDeps } from './autopilot.js';
import { runAutopilotTick } from './autopilot.js';

const AUTOPILOT_TICK_INTERVAL_MS = 60_000;

/** @public Daemon job that drives the per-mission autopilot state machine. */
export function missionsAutopilotPollJob(deps: AutopilotDeps): JobDefinition {
  return {
    id: 'missions.autopilot.poll',
    intervalMs: AUTOPILOT_TICK_INTERVAL_MS,
    runOnStart: true,
    run: async () => {
      await runAutopilotTick(deps);
    },
  };
}
