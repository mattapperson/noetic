import type { TaskStoreContext } from '../fs-store.js';
import { listTasks } from '../fs-store.js';
import { deriveColumn, KanbanColumn } from '../kanban.js';
import type { Task, TaskSource } from '../schemas.js';

//#region Types

export interface ListTasksArgs {
  /** When set, only tasks whose derived column matches are returned. */
  readonly column?: KanbanColumn;
  /**
   * When true, include archived tasks (and, by extension, every other
   * normally-hidden column). Strict superset of {@link terminal}.
   */
  readonly all?: boolean;
  /**
   * When true, include the non-archived terminal columns
   * (`cleanup_blocked`, `removed`) that the default view hides.
   * Archived tasks remain hidden unless {@link all} is also set.
   */
  readonly terminal?: boolean;
  /** Optionally restrict by `source` (manual | worktree). */
  readonly source?: TaskSource;
}

export interface ListTasksResult {
  readonly tasks: Task[];
}

//#endregion

//#region Helpers

/**
 * Non-archived terminal columns hidden by default; revealed by
 * `--terminal` (and by `--all`).
 */
const TERMINAL_NON_ARCHIVED_COLUMNS: ReadonlySet<KanbanColumn> = new Set([
  KanbanColumn.CleanupBlocked,
  KanbanColumn.Removed,
]);

function matchesColumn(column: KanbanColumn, filter: KanbanColumn | undefined): boolean {
  if (filter === undefined) {
    return true;
  }
  return column === filter;
}

function matchesSource(task: Task, source: TaskSource | undefined): boolean {
  if (source === undefined) {
    return true;
  }
  return task.source === source;
}

/**
 * The default view hides archived tasks AND the non-archived terminal
 * columns (`cleanup_blocked`, `removed`) so the CLI matches the kanban
 * TUI's default (which only renders Triage / In Progress / Needs
 * Changes / Ready to Merge / Done unless `a` is pressed).
 *
 * - `--all`: lifts both hides.
 * - `--terminal`: lifts only the non-archived terminal hide; archived
 *   tasks remain hidden.
 * - An explicit `--column <hidden>` lifts whichever hide the column
 *   sits behind (otherwise the filter would return empty).
 */
function passesVisibilityGate(column: KanbanColumn, args: ListTasksArgs): boolean {
  if (column === KanbanColumn.Archived) {
    if (args.all === true) {
      return true;
    }
    return args.column === KanbanColumn.Archived;
  }
  if (TERMINAL_NON_ARCHIVED_COLUMNS.has(column)) {
    if (args.all === true || args.terminal === true) {
      return true;
    }
    return args.column === column;
  }
  return true;
}

//#endregion

//#region Public API

/**
 * Enumerate every task on disk and apply caller-supplied filters. Sort
 * order is the most-recent-update first so the kanban view picks up
 * fresh activity at the top.
 *
 * Defaults match the TUI kanban: archived tasks and the terminal
 * columns (`cleanup_blocked`, `removed`) are hidden unless the caller
 * passes `all` / `terminal` or filters explicitly with `column`.
 */
export async function listTasksHandler(
  ctx: TaskStoreContext,
  args: ListTasksArgs,
): Promise<ListTasksResult> {
  const all = await listTasks(ctx);
  const filtered = all.filter((task) => {
    const column = deriveColumn(task);
    return (
      passesVisibilityGate(column, args) &&
      matchesColumn(column, args.column) &&
      matchesSource(task, args.source)
    );
  });
  filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return {
    tasks: filtered,
  };
}

//#endregion
