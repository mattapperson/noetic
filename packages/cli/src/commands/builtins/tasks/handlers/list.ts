import type { TaskStoreContext } from '../fs-store.js';
import { listTasks } from '../fs-store.js';
import type { KanbanColumn } from '../kanban.js';
import { deriveColumn } from '../kanban.js';
import type { Task, TaskSource } from '../schemas.js';

//#region Types

export interface ListTasksArgs {
  /** When set, only tasks whose derived column matches are returned. */
  readonly column?: KanbanColumn;
  /** When false (default), archived tasks are filtered out. */
  readonly all?: boolean;
  /** Optionally restrict by `source` (manual | worktree). */
  readonly source?: TaskSource;
}

export interface ListTasksResult {
  readonly tasks: Task[];
}

//#endregion

//#region Helpers

function matchesColumn(task: Task, column: KanbanColumn | undefined): boolean {
  if (column === undefined) {
    return true;
  }
  return deriveColumn(task) === column;
}

function matchesSource(task: Task, source: TaskSource | undefined): boolean {
  if (source === undefined) {
    return true;
  }
  return task.source === source;
}

function matchesArchived(task: Task, all: boolean | undefined): boolean {
  if (all === true) {
    return true;
  }
  return task.archivedAt === null;
}

//#endregion

//#region Public API

/**
 * Enumerate every task on disk and apply caller-supplied filters. Sort
 * order is the most-recent-update first so the kanban view picks up
 * fresh activity at the top.
 */
export async function listTasksHandler(
  ctx: TaskStoreContext,
  args: ListTasksArgs,
): Promise<ListTasksResult> {
  const all = await listTasks(ctx);
  const filtered = all.filter(
    (task) =>
      matchesArchived(task, args.all) &&
      matchesColumn(task, args.column) &&
      matchesSource(task, args.source),
  );
  filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return {
    tasks: filtered,
  };
}

//#endregion
