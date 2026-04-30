import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent, saveTask } from '../fs-store.js';
import type { Task } from '../schemas.js';
import { EventKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface ArchiveTaskArgs {
  readonly taskId: string;
}

export interface ArchiveTaskResult {
  readonly task: Task;
}

//#endregion

//#region Public API

/**
 * Mark a task archived by stamping `archivedAt`. Idempotent: if the
 * task is already archived, the existing timestamp is preserved.
 */
export async function archiveTaskHandler(
  ctx: TaskStoreContext,
  args: ArchiveTaskArgs,
): Promise<ArchiveTaskResult> {
  const existing = await resolveTask(ctx, args.taskId);
  const ts = nowIso();
  const next: Task = {
    ...existing,
    archivedAt: existing.archivedAt ?? ts,
    updatedAt: ts,
  };
  await saveTask(ctx, next);
  await appendEvent(ctx, {
    taskId: next.id,
    kind: EventKind.TaskArchived,
    payload: {
      archivedAt: next.archivedAt,
    },
    ts,
  });
  return {
    task: next,
  };
}

//#endregion
