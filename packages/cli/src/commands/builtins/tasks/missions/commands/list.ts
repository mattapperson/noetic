/**
 * `/mission list` — text output of all missions grouped by status.
 */

import type { MissionRecord, MissionStatus } from '../../db/schema.js';
import { listMissions } from '../store.js';

const STATUS_ORDER: ReadonlyArray<MissionStatus> = [
  'planning',
  'active',
  'blocked',
  'complete',
  'archived',
];

export async function runMissionList(cwd: string): Promise<string> {
  const missions = listMissions(cwd);
  if (missions.length === 0) {
    return 'No missions yet. Use `/mission new` to create one.';
  }
  const grouped = new Map<MissionStatus, MissionRecord[]>();
  for (const record of missions) {
    const list = grouped.get(record.status) ?? [];
    list.push(record);
    grouped.set(record.status, list);
  }
  const sections: string[] = [];
  for (const status of STATUS_ORDER) {
    const list = grouped.get(status);
    if (list === undefined || list.length === 0) {
      continue;
    }
    sections.push(`# ${status} (${list.length})`);
    for (const mission of list) {
      const desc = mission.description !== null ? ` — ${mission.description}` : '';
      const autopilot = mission.autopilotEnabled ? ' [autopilot]' : '';
      sections.push(`  ${mission.id}  ${mission.title}${desc}${autopilot}`);
    }
    sections.push('');
  }
  return sections.join('\n').trimEnd();
}
