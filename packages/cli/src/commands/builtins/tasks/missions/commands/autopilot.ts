/**
 * `/mission autopilot <on|off> <missionId>` — toggle autopilot on a mission.
 */

import { ensureDaemon } from '../../../../../daemon-runtime/runtime.js';
import { getMission, updateMission } from '../store.js';

export interface MissionAutopilotDeps {
  ensureDaemonFn?: (cwd: string) => void;
}

const TOGGLE_VALUES = new Set([
  'on',
  'off',
]);

export async function runMissionAutopilot(
  cwd: string,
  argText: string,
  deps: MissionAutopilotDeps = {},
): Promise<string> {
  const tokens = argText.trim().split(/\s+/);
  const toggle = tokens[0];
  const missionId = tokens[1];
  if (
    toggle === undefined ||
    !TOGGLE_VALUES.has(toggle) ||
    missionId === undefined ||
    missionId.length === 0
  ) {
    return 'Usage: /mission autopilot <on|off> <missionId>';
  }
  const existing = getMission(cwd, missionId);
  if (existing === null) {
    return `Mission ${missionId} not found.`;
  }
  const enable = toggle === 'on';
  updateMission(cwd, missionId, {
    autopilotEnabled: enable,
    autopilotState: enable ? 'watching' : 'inactive',
  });
  if (enable) {
    const ensureDaemonFn = deps.ensureDaemonFn ?? ensureDaemon;
    ensureDaemonFn(cwd);
  }
  return `Autopilot ${enable ? 'enabled' : 'disabled'} for mission ${missionId}.`;
}
