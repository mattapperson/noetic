import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent, saveTask } from '../fs-store.js';
import type { Task } from '../schemas.js';
import { AutopilotState, EventKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface AutopilotArgs {
  readonly taskId: string;
  readonly enabled: boolean;
}

export interface AutopilotResult {
  readonly task: Task;
  readonly previousEnabled: boolean;
}

//#endregion

//#region Public API

/**
 * Flip a task's `autopilotEnabled` flag. Disabling resets the
 * autopilot state machine to `inactive` so the daemon doesn't pick
 * the task back up; enabling moves the task into `watching` so the
 * autopilot tick will consider it on the next pass.
 */
export async function autopilotHandler(
  ctx: TaskStoreContext,
  args: AutopilotArgs,
): Promise<AutopilotResult> {
  const existing = await resolveTask(ctx, args.taskId);
  const previousEnabled = existing.autopilotEnabled;
  if (previousEnabled === args.enabled) {
    return {
      task: existing,
      previousEnabled,
    };
  }
  const ts = nowIso();
  const next: Task = {
    ...existing,
    autopilotEnabled: args.enabled,
    autopilotState: args.enabled ? AutopilotState.Watching : AutopilotState.Inactive,
    lastAutopilotActivityAt: args.enabled ? ts : existing.lastAutopilotActivityAt,
    updatedAt: ts,
  };
  await saveTask(ctx, next);
  await appendEvent(ctx, {
    taskId: next.id,
    kind: EventKind.TaskUpdated,
    payload: {
      autopilotEnabled: next.autopilotEnabled,
      autopilotState: next.autopilotState,
    },
    ts,
  });
  return {
    task: next,
    previousEnabled,
  };
}

//#endregion
