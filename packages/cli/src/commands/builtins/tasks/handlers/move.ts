import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent } from '../fs-store.js';
import type { KanbanColumn } from '../kanban.js';
import { deriveColumn, moveTask } from '../kanban.js';
import type { Task } from '../schemas.js';
import { EventKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface MoveTaskHandlerArgs {
  readonly taskId: string;
  readonly column: KanbanColumn;
}

export interface MoveTaskHandlerResult {
  readonly task: Task;
  readonly previousColumn: KanbanColumn;
  readonly column: KanbanColumn;
}

//#endregion

//#region Public API

/**
 * Move a task into a kanban column. Looks up the previous column from
 * the existing task record so the emitted event carries both endpoints
 * — useful for any UI tracking column-to-column transitions.
 */
export async function moveTaskHandler(
  ctx: TaskStoreContext,
  args: MoveTaskHandlerArgs,
): Promise<MoveTaskHandlerResult> {
  const existing = await resolveTask(ctx, args.taskId);
  const previousColumn = deriveColumn(existing);
  const updated = await moveTask(ctx, {
    taskId: args.taskId,
    column: args.column,
  });
  await appendEvent(ctx, {
    taskId: updated.id,
    kind: EventKind.TaskMoved,
    payload: {
      previousColumn,
      column: args.column,
    },
    ts: nowIso(),
  });
  return {
    task: updated,
    previousColumn,
    column: args.column,
  };
}

//#endregion
