import { KanbanColumn } from '../../../tasks/runtime/kanban.js';

/**
 * Stable column ordering shown in the UI. Only active pre-merge
 * columns are surfaced here — Done and the terminal-state columns
 * (Cleanup Blocked, Removed, Archived) are intentionally omitted so
 * tasks in those states drop off the board and the move picker.
 */
export const VISIBLE_COLUMNS: ReadonlyArray<KanbanColumn> = [
  KanbanColumn.Triage,
  KanbanColumn.InProgress,
  KanbanColumn.NeedsChanges,
  KanbanColumn.ReadyToMerge,
];

const COLUMN_LABELS: Record<KanbanColumn, string> = {
  [KanbanColumn.Triage]: 'Triage',
  [KanbanColumn.InProgress]: 'In Progress',
  [KanbanColumn.NeedsChanges]: 'Needs Changes',
  [KanbanColumn.ReadyToMerge]: 'Ready to PR',
  [KanbanColumn.CleanupBlocked]: 'Cleanup Blocked',
  [KanbanColumn.Removed]: 'Removed',
  [KanbanColumn.Archived]: 'Archived',
};

export function columnLabel(column: KanbanColumn): string {
  return COLUMN_LABELS[column];
}
