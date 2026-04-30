import type { TaskStoreContext } from './fs-store.js';
import { loadTask, saveTask } from './fs-store.js';
import type { Task } from './schemas.js';
import { TaskLifecycleStatus, TaskReviewStatus } from './schemas.js';

//#region Kanban column enum

/**
 * Logical kanban columns derived from a `Task`'s state. The mapping is
 * deterministic over (`reviewStatus` × `lifecycleStatus` × `archivedAt`):
 * archived/lifecycle terminals win first, then `reviewStatus` for active
 * tasks. `source` is *not* part of the column matrix — it's a card badge,
 * not a column.
 */
export const KanbanColumn = {
  Triage: 'triage',
  InProgress: 'in_progress',
  NeedsChanges: 'needs_changes',
  ReadyToMerge: 'ready_to_merge',
  Done: 'done',
  CleanupBlocked: 'cleanup_blocked',
  Removed: 'removed',
  Archived: 'archived',
} as const;

export type KanbanColumn = (typeof KanbanColumn)[keyof typeof KanbanColumn];

//#endregion

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

const REVIEW_STATUS_TO_COLUMN: Record<TaskReviewStatus, KanbanColumn> = {
  [TaskReviewStatus.NotStarted]: KanbanColumn.Triage,
  [TaskReviewStatus.Reviewing]: KanbanColumn.InProgress,
  [TaskReviewStatus.NeedsChanges]: KanbanColumn.NeedsChanges,
  [TaskReviewStatus.Approved]: KanbanColumn.ReadyToMerge,
};

const COLUMN_TO_REVIEW_STATUS: Partial<Record<KanbanColumn, TaskReviewStatus>> = {
  [KanbanColumn.Triage]: TaskReviewStatus.NotStarted,
  [KanbanColumn.InProgress]: TaskReviewStatus.Reviewing,
  [KanbanColumn.NeedsChanges]: TaskReviewStatus.NeedsChanges,
  [KanbanColumn.ReadyToMerge]: TaskReviewStatus.Approved,
};

//#endregion

//#region deriveColumn

/**
 * Map a `Task` to its kanban column. Terminal states (archived, merged,
 * cleanup-blocked, removed) take precedence over the review-status axis.
 */
export function deriveColumn(task: Task): KanbanColumn {
  if (task.archivedAt !== null) {
    return KanbanColumn.Archived;
  }
  if (task.lifecycleStatus === TaskLifecycleStatus.Merged) {
    return KanbanColumn.Done;
  }
  if (task.lifecycleStatus === TaskLifecycleStatus.CleanupBlocked) {
    return KanbanColumn.CleanupBlocked;
  }
  if (task.lifecycleStatus === TaskLifecycleStatus.Removed) {
    return KanbanColumn.Removed;
  }
  // Active lifecycle: dispatch on review status.
  return REVIEW_STATUS_TO_COLUMN[task.reviewStatus];
}

//#endregion

//#region moveTask

export interface MoveTaskOptions {
  readonly taskId: string;
  readonly column: KanbanColumn;
}

interface ColumnPatch {
  readonly archivedAt: string | null;
  readonly lifecycleStatus: Task['lifecycleStatus'];
  readonly reviewStatus: TaskReviewStatus;
}

function buildPatchForReviewColumn(args: {
  task: Task;
  column: KanbanColumn;
  now: string;
}): ColumnPatch {
  const reviewStatus = COLUMN_TO_REVIEW_STATUS[args.column];
  if (reviewStatus === undefined) {
    throw new Error(`Unsupported review-status column: ${args.column}`);
  }
  return {
    archivedAt: null,
    lifecycleStatus: TaskLifecycleStatus.Active,
    reviewStatus,
  };
}

function buildPatch(args: { task: Task; column: KanbanColumn; now: string }): ColumnPatch {
  const { task, column, now } = args;
  if (column === KanbanColumn.Archived) {
    return {
      archivedAt: task.archivedAt ?? now,
      lifecycleStatus: task.lifecycleStatus,
      reviewStatus: task.reviewStatus,
    };
  }
  if (column === KanbanColumn.Done) {
    return {
      archivedAt: null,
      lifecycleStatus: TaskLifecycleStatus.Merged,
      reviewStatus: task.reviewStatus,
    };
  }
  if (column === KanbanColumn.CleanupBlocked) {
    return {
      archivedAt: null,
      lifecycleStatus: TaskLifecycleStatus.CleanupBlocked,
      reviewStatus: task.reviewStatus,
    };
  }
  if (column === KanbanColumn.Removed) {
    return {
      archivedAt: null,
      lifecycleStatus: TaskLifecycleStatus.Removed,
      reviewStatus: task.reviewStatus,
    };
  }
  return buildPatchForReviewColumn({
    task,
    column,
    now,
  });
}

/**
 * Atomically transition `task` into `column`, computing the minimum patch
 * across `archivedAt` / `lifecycleStatus` / `reviewStatus` to land there.
 *
 * Caller is responsible for emitting any kanban-related events; this
 * function only owns the canonical state mutation.
 */
export async function moveTask(ctx: TaskStoreContext, options: MoveTaskOptions): Promise<Task> {
  const existing = await loadTask(ctx, options.taskId);
  const now = nowIso();
  const patch = buildPatch({
    task: existing,
    column: options.column,
    now,
  });
  const next: Task = {
    ...existing,
    archivedAt: patch.archivedAt,
    lifecycleStatus: patch.lifecycleStatus,
    reviewStatus: patch.reviewStatus,
    updatedAt: now,
  };
  await saveTask(ctx, next);
  return next;
}

//#endregion
