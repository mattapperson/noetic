import type { Task } from '@noetic/code-agent/tasks/schema';
import { EventKind } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { appendEvent } from '@noetic/code-agent/tasks/store/fs-node';
import { deriveColumn, KanbanColumn, moveTask } from '../kanban.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface MoveTaskHandlerArgs {
  readonly taskId: string;
  readonly column: KanbanColumn;
  /**
   * Override the reconciler-owned guard. Required to move a task
   * INTO `removed` or `cleanup_blocked` since those columns are
   * normally only reached by the daemon's reconcile pass.
   */
  readonly force?: boolean;
}

export interface MoveTaskHandlerResult {
  readonly task: Task;
  readonly previousColumn: KanbanColumn;
  readonly column: KanbanColumn;
}

//#endregion

//#region Helpers

/**
 * Columns that are typically owned by daemon-side state machines, not
 * direct user moves: `removed` (set by `reconcile-flow` when a worktree
 * disappears) and `cleanup_blocked` (set by the cleanup subsystem when
 * post-merge cleanup fails). Manual moves into these need `--force` to
 * avoid silent state oscillation when the next reconcile tick reverts
 * the user's change.
 */
const RECONCILER_OWNED_COLUMNS: ReadonlySet<KanbanColumn> = new Set([
  KanbanColumn.Removed,
  KanbanColumn.CleanupBlocked,
]);

//#endregion

//#region Public API

/**
 * Move a task into a kanban column. Looks up the previous column from
 * the existing task record so the emitted event carries both endpoints
 * — useful for any UI tracking column-to-column transitions.
 *
 * Refuses to move a task INTO a reconciler-owned terminal column
 * (`removed`, `cleanup_blocked`) without an explicit `force: true`.
 * Moves OUT of those columns are always allowed (operator override).
 */
export async function moveTaskHandler(
  ctx: TaskStoreContext,
  args: MoveTaskHandlerArgs,
): Promise<MoveTaskHandlerResult> {
  const existing = await resolveTask(ctx, args.taskId);
  const previousColumn = deriveColumn(existing);
  if (RECONCILER_OWNED_COLUMNS.has(args.column) && args.force !== true) {
    throw new Error(
      `Refusing to move ${args.taskId} to '${args.column}': this column is reconciler-owned. Pass --force if you really mean it.`,
    );
  }
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
