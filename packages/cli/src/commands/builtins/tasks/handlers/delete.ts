import { emitTaskEvent } from '../events.js';
import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent, deleteTaskDir } from '../fs-store.js';
import { EventKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface DeleteTaskArgs {
  readonly taskId: string;
}

export interface DeleteTaskResult {
  readonly taskId: string;
}

//#endregion

//#region Public API

/**
 * Hard-delete a task. Emits `task:archived` first so listeners that
 * mirror state to other surfaces (UI lists, search indexes) can drop
 * the task's row, then removes the on-disk directory.
 */
export async function deleteTaskHandler(
  ctx: TaskStoreContext,
  args: DeleteTaskArgs,
): Promise<DeleteTaskResult> {
  const existing = await resolveTask(ctx, args.taskId);
  const ts = nowIso();
  const event = await appendEvent(ctx, {
    taskId: existing.id,
    kind: EventKind.TaskArchived,
    payload: {
      reason: 'deleted',
    },
    ts,
  });
  emitTaskEvent(event);
  await deleteTaskDir(ctx, existing.id);
  return {
    taskId: existing.id,
  };
}

//#endregion
