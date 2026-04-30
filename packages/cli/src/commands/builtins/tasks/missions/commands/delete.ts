/**
 * `/mission delete <missionId>` — delete a mission and its descendants (cascades via FK).
 */

import { deleteMission, getMission } from '../store.js';

export async function runMissionDelete(cwd: string, argText: string): Promise<string> {
  const missionId = argText.trim();
  if (missionId.length === 0) {
    return 'Usage: /mission delete <missionId>';
  }
  const existing = getMission(cwd, missionId);
  if (existing === null) {
    return `Mission ${missionId} not found.`;
  }
  deleteMission(cwd, missionId);
  return `Deleted mission ${missionId}.`;
}
