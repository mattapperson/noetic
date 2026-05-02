/**
 * Resolve a task → IPC socket so the TUI can open a chat with whichever
 * agent is currently active on that task.
 *
 * Priority order:
 *   1. planner sidecar (`_planner.json`) — present iff a planner runner
 *      is bound to this task.
 *   2. implementer sidecar (`_implementer.json`) — present iff an
 *      implementer runner is bound to this leaf task.
 *
 * Returns `null` when no live agent is bound (e.g. autopilot is paused
 * or the task has terminated).
 */

import type { TaskStoreContext } from './fs-store.js';
import { loadImplementer } from './implementer-state.js';
import { loadPlanner } from './planner-state.js';

//#region Types

export interface ChatTarget {
  readonly socketPath: string;
  readonly role: 'planner' | 'implementer';
  readonly roleLabel: string;
}

//#endregion

//#region Public API

export async function resolveChatTarget(
  ctx: TaskStoreContext,
  taskId: string,
): Promise<ChatTarget | null> {
  const planner = await loadPlanner(ctx, taskId);
  if (planner !== null && planner.socketPath !== null && planner.socketPath !== undefined) {
    return {
      socketPath: planner.socketPath,
      role: 'planner',
      roleLabel: 'planner',
    };
  }
  const implementer = await loadImplementer(ctx, taskId);
  if (
    implementer !== null &&
    implementer.socketPath !== null &&
    implementer.socketPath !== undefined
  ) {
    return {
      socketPath: implementer.socketPath,
      role: 'implementer',
      roleLabel: `implementer · ${implementer.featureId}`,
    };
  }
  return null;
}

//#endregion
