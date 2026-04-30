/**
 * Renders the `/mission show <id>` Ink modal. Split from the dispatcher so the
 * dispatcher (a `.ts` file) does not pull in JSX.
 */

import type { ReactNode } from 'react';

import type { LocalJsxCommandOnDone } from '../../../../types.js';
import type { MissionHierarchy } from '../store.js';
import { getMissionWithHierarchy } from '../store.js';
import { MissionShowContainer, MissionShowError } from './show.js';

export interface RenderMissionShowArgs {
  cwd: string;
  missionId: string;
  onDone: LocalJsxCommandOnDone;
}

export function renderMissionShow(args: RenderMissionShowArgs): ReactNode {
  const { cwd, missionId, onDone } = args;
  let hierarchy: MissionHierarchy | null;
  try {
    hierarchy = getMissionWithHierarchy(cwd, missionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return (
      <MissionShowError
        message={message}
        onClose={() => {
          onDone(`Mission show failed: ${message}`);
        }}
      />
    );
  }
  if (hierarchy === null) {
    onDone(`Mission ${missionId} not found.`);
    return null;
  }
  return (
    <MissionShowContainer
      cwd={cwd}
      missionId={missionId}
      initial={hierarchy}
      onClose={() => {
        onDone('Mission view closed.');
      }}
    />
  );
}
