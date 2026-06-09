/**
 * Read and append-only handlers: show, list, log, logs, comment.
 */

import type { LogEntry, Task, TaskSource } from '@noetic-tools/code-agent/tasks/schema';
import { LogEntryKind } from '@noetic-tools/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic-tools/code-agent/tasks/store/fs-node';
import { appendLog, listTasks, tailLog } from '@noetic-tools/code-agent/tasks/store/fs-node';
import { getTaskHierarchy } from '../hierarchy/aggregate.js';
import type { TaskHierarchy } from '../hierarchy/schemas.js';
import { deriveColumn, KanbanColumn } from '../kanban.js';
import { nowIso, resolveTask } from './_shared.js';

//#region show

export interface ShowTaskArgs {
  readonly taskId: string;
  /** How many trailing log entries to include (default 20). */
  readonly logTail?: number;
}

export interface ShowTaskResult {
  readonly task: Task;
  readonly recentLog: LogEntry[];
  readonly hierarchy: TaskHierarchy | null;
}

/**
 * Read-only view of a task: the canonical record, the most recent log
 * entries, and the hierarchy summary if the task has one.
 */
export async function showTaskHandler(
  ctx: TaskStoreContext,
  args: ShowTaskArgs,
): Promise<ShowTaskResult> {
  const task = await resolveTask(ctx, args.taskId);
  const recentLog = await tailLog(ctx, {
    taskId: task.id,
    n: args.logTail ?? 20,
  });
  const hierarchy = await getTaskHierarchy(ctx, task.id);
  return {
    task,
    recentLog,
    hierarchy,
  };
}

//#endregion

//#region list

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
 * Changes / Ready to PR — merged tasks collapse into Ready to PR).
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

//#region log

export interface LogTaskArgs {
  readonly taskId: string;
  readonly message: string;
}

export interface LogTaskResult {
  readonly entry: LogEntry;
}

/**
 * Append a freeform `log`-kind entry to the task's audit trail. Use
 * `commentTaskHandler` for human-authored remarks and `steerTaskHandler`
 * for steering directives that should also land in `steering.md`.
 */
export async function logTaskHandler(
  ctx: TaskStoreContext,
  args: LogTaskArgs,
): Promise<LogTaskResult> {
  await resolveTask(ctx, args.taskId);
  const entry: LogEntry = {
    kind: LogEntryKind.Log,
    ts: nowIso(),
    message: args.message,
  };
  await appendLog(ctx, {
    taskId: args.taskId,
    entry,
  });
  return {
    entry,
  };
}

//#endregion

//#region logs

export interface LogsTaskArgs {
  readonly taskId: string;
  /** Number of trailing entries to return (default 50). */
  readonly n?: number;
}

export interface LogsTaskResult {
  readonly entries: LogEntry[];
}

/** Tail the last `n` entries of a task's `log.jsonl`. */
export async function logsTaskHandler(
  ctx: TaskStoreContext,
  args: LogsTaskArgs,
): Promise<LogsTaskResult> {
  await resolveTask(ctx, args.taskId);
  const entries = await tailLog(ctx, {
    taskId: args.taskId,
    n: args.n,
  });
  return {
    entries,
  };
}

//#endregion

//#region comment

export interface CommentTaskArgs {
  readonly taskId: string;
  readonly message: string;
}

export interface CommentTaskResult {
  readonly entry: LogEntry;
}

/** Append a `comment`-kind log entry to a task's audit trail. */
export async function commentTaskHandler(
  ctx: TaskStoreContext,
  args: CommentTaskArgs,
): Promise<CommentTaskResult> {
  await resolveTask(ctx, args.taskId);
  const trimmed = args.message.trim();
  if (trimmed.length === 0) {
    throw new Error('Comment message must not be empty');
  }
  const entry: LogEntry = {
    kind: LogEntryKind.Comment,
    ts: nowIso(),
    message: trimmed,
  };
  await appendLog(ctx, {
    taskId: args.taskId,
    entry,
  });
  return {
    entry,
  };
}

//#endregion
