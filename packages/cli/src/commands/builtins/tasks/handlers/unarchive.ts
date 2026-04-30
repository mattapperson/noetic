import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent, saveTask } from '../fs-store.js';
import type { Task } from '../schemas.js';
import { EventKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface UnarchiveTaskArgs {
  readonly taskId: string;
}

export interface UnarchiveTaskResult {
  readonly task: Task;
}

//#endregion

//#region Public API

/** Clear `archivedAt`, returning the task to its prior column. */
export async function unarchiveTaskHandler(
  ctx: TaskStoreContext,
  args: UnarchiveTaskArgs,
): Promise<UnarchiveTaskResult> {
  const existing = await resolveTask(ctx, args.taskId);
  const ts = nowIso();
  const next: Task = {
    ...existing,
    archivedAt: null,
    updatedAt: ts,
  };
  await saveTask(ctx, next);
  await appendEvent(ctx, {
    taskId: next.id,
    kind: EventKind.TaskArchived,
    payload: {
      archivedAt: null,
    },
    ts,
  });
  return {
    task: next,
  };
}

//#endregion
