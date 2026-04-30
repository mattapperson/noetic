/**
 * Full-screen kanban board view. Loads every task in the project and lays
 * them out by `deriveColumn`. Arrow keys move the selection across columns
 * and within a column, Enter drills into the highlighted task, `c`
 * launches the create-form, `m` opens the move picker, and `Esc` returns
 * to the chat view.
 *
 * Pure helpers (`groupTasksByColumn`, `selectionAfterKey`, etc.) are
 * exported so unit tests can exercise the navigation/grouping logic
 * without rendering Ink.
 */

import type { FsAdapter } from '@noetic/core';
import { Box, Text, useInput, useStdout } from 'ink';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTheme } from '../../../../tui/components/theme.js';
import type { TaskStoreContext } from '../fs-store.js';
import { hasHierarchy, listTasks } from '../fs-store.js';
import { deriveColumn, KanbanColumn } from '../kanban.js';
import type { Task } from '../schemas.js';
import { TaskCard } from './task-card.js';
import { useEventsTail } from './use-events-tail.js';

//#region Types

export interface TaskBoardProps {
  /** Project root holding `.noetic/tasks/`. */
  projectRoot: string;
  /** FS adapter used to load tasks. */
  fs: FsAdapter;
  /** Called when the user presses `Esc` to leave the board. */
  onExit: () => void;
  /** Called when the user presses Enter on a leaf task. */
  onOpenTask?: (task: Task) => void;
  /** Called when the user presses Enter on a structured task. */
  onOpenHierarchy?: (task: Task) => void;
  /** Called when the user presses `c` to create a new task. */
  onCreateTask?: () => void;
  /** Called when the user presses `m` to move the selected task. */
  onMoveTask?: (task: Task) => void;
}

/** A single task with its derived column and structured-flag pre-computed. */
export interface DecoratedTask {
  readonly task: Task;
  readonly column: KanbanColumn;
  readonly isStructured: boolean;
}

/** Selection coordinate over the column-major task layout. */
export interface BoardSelection {
  readonly columnIndex: number;
  readonly rowIndex: number;
}

//#endregion

//#region Helpers

/** Stable column ordering shown in the UI. Active columns first, terminal last. */
export const VISIBLE_COLUMNS: ReadonlyArray<KanbanColumn> = [
  KanbanColumn.Triage,
  KanbanColumn.InProgress,
  KanbanColumn.NeedsChanges,
  KanbanColumn.ReadyToMerge,
  KanbanColumn.Done,
  KanbanColumn.CleanupBlocked,
  KanbanColumn.Removed,
  KanbanColumn.Archived,
];

const COLUMN_LABELS: Record<KanbanColumn, string> = {
  [KanbanColumn.Triage]: 'Triage',
  [KanbanColumn.InProgress]: 'In Progress',
  [KanbanColumn.NeedsChanges]: 'Needs Changes',
  [KanbanColumn.ReadyToMerge]: 'Ready to Merge',
  [KanbanColumn.Done]: 'Done',
  [KanbanColumn.CleanupBlocked]: 'Cleanup Blocked',
  [KanbanColumn.Removed]: 'Removed',
  [KanbanColumn.Archived]: 'Archived',
};

export function columnLabel(column: KanbanColumn): string {
  return COLUMN_LABELS[column];
}

/** Bucket tasks by column, preserving input order within each bucket. */
export function groupTasksByColumn(
  decorated: ReadonlyArray<DecoratedTask>,
): Map<KanbanColumn, DecoratedTask[]> {
  const buckets = new Map<KanbanColumn, DecoratedTask[]>();
  for (const column of VISIBLE_COLUMNS) {
    buckets.set(column, []);
  }
  for (const item of decorated) {
    const bucket = buckets.get(item.column);
    if (bucket === undefined) {
      continue;
    }
    bucket.push(item);
  }
  return buckets;
}

interface NavInput {
  readonly columnIndex: number;
  readonly rowIndex: number;
  readonly key: 'left' | 'right' | 'up' | 'down';
  readonly buckets: ReadonlyMap<KanbanColumn, ReadonlyArray<DecoratedTask>>;
}

/**
 * Compute the next selection after a directional key. Empty columns are
 * skipped on horizontal moves so the user can never land on a column
 * with no rows. Vertical moves clamp at the column's bounds.
 */
export function selectionAfterKey(input: NavInput): BoardSelection {
  const cols = VISIBLE_COLUMNS;
  if (input.key === 'up') {
    return {
      columnIndex: input.columnIndex,
      rowIndex: Math.max(0, input.rowIndex - 1),
    };
  }
  if (input.key === 'down') {
    const here = input.buckets.get(cols[input.columnIndex] ?? KanbanColumn.Triage) ?? [];
    return {
      columnIndex: input.columnIndex,
      rowIndex: Math.min(Math.max(0, here.length - 1), input.rowIndex + 1),
    };
  }
  const dir = input.key === 'right' ? 1 : -1;
  let nextCol = input.columnIndex + dir;
  while (nextCol >= 0 && nextCol < cols.length) {
    const colKey = cols[nextCol];
    if (colKey === undefined) {
      break;
    }
    const bucket = input.buckets.get(colKey) ?? [];
    if (bucket.length > 0) {
      return {
        columnIndex: nextCol,
        rowIndex: Math.min(input.rowIndex, bucket.length - 1),
      };
    }
    nextCol += dir;
  }
  // No non-empty column found in that direction — stay put.
  return {
    columnIndex: input.columnIndex,
    rowIndex: input.rowIndex,
  };
}

/** Find the task currently under the selection, or null if the slot is empty. */
export function selectedTask(
  buckets: ReadonlyMap<KanbanColumn, ReadonlyArray<DecoratedTask>>,
  selection: BoardSelection,
): DecoratedTask | null {
  const colKey = VISIBLE_COLUMNS[selection.columnIndex];
  if (colKey === undefined) {
    return null;
  }
  const bucket = buckets.get(colKey) ?? [];
  return bucket[selection.rowIndex] ?? null;
}

//#endregion

//#region Loader

interface BoardData {
  readonly tasks: ReadonlyArray<DecoratedTask>;
  readonly error: string | null;
  readonly loaded: boolean;
}

const EMPTY_BOARD_DATA: BoardData = {
  tasks: [],
  error: null,
  loaded: false,
};

async function loadBoardData(ctx: TaskStoreContext): Promise<BoardData> {
  try {
    const tasks = await listTasks(ctx);
    const decorated = await Promise.all(
      tasks.map(
        async (task): Promise<DecoratedTask> => ({
          task,
          column: deriveColumn(task),
          isStructured: await hasHierarchy(ctx, task.id),
        }),
      ),
    );
    return {
      tasks: decorated,
      error: null,
      loaded: true,
    };
  } catch (err) {
    return {
      tasks: [],
      error: err instanceof Error ? err.message : String(err),
      loaded: true,
    };
  }
}

//#endregion

//#region Component

export function TaskBoard(props: TaskBoardProps): React.ReactElement {
  const theme = useTheme();
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 100;
  const [data, setData] = useState<BoardData>(EMPTY_BOARD_DATA);
  const [selection, setSelection] = useState<BoardSelection>({
    columnIndex: 0,
    rowIndex: 0,
  });

  const ctx = useMemo<TaskStoreContext>(
    () => ({
      fs: props.fs,
      projectRoot: props.projectRoot,
    }),
    [
      props.fs,
      props.projectRoot,
    ],
  );

  const { revision } = useEventsTail({
    projectRoot: props.projectRoot,
    fs: props.fs,
  });

  // Re-load on mount and on every event-tail bump (revision changes).
  useEffect(() => {
    // Read so the effect closure depends on revision; we don't need the value.
    void revision;
    let cancelled = false;
    void loadBoardData(ctx).then((next) => {
      if (cancelled) {
        return;
      }
      setData(next);
    });
    return () => {
      cancelled = true;
    };
  }, [
    ctx,
    revision,
  ]);

  const buckets = useMemo(
    () => groupTasksByColumn(data.tasks),
    [
      data.tasks,
    ],
  );

  const handleNav = useCallback(
    (key: 'left' | 'right' | 'up' | 'down'): void => {
      setSelection((current) =>
        selectionAfterKey({
          columnIndex: current.columnIndex,
          rowIndex: current.rowIndex,
          key,
          buckets,
        }),
      );
    },
    [
      buckets,
    ],
  );

  useInput((input, key) => {
    if (key.escape) {
      props.onExit();
      return;
    }
    if (key.leftArrow) {
      handleNav('left');
      return;
    }
    if (key.rightArrow) {
      handleNav('right');
      return;
    }
    if (key.upArrow) {
      handleNav('up');
      return;
    }
    if (key.downArrow) {
      handleNav('down');
      return;
    }
    if (key.return) {
      const picked = selectedTask(buckets, selection);
      if (picked === null) {
        return;
      }
      if (picked.isStructured && props.onOpenHierarchy) {
        props.onOpenHierarchy(picked.task);
        return;
      }
      if (props.onOpenTask) {
        props.onOpenTask(picked.task);
      }
      return;
    }
    if (input === 'c' && props.onCreateTask) {
      props.onCreateTask();
      return;
    }
    if (input === 'm' && props.onMoveTask) {
      const picked = selectedTask(buckets, selection);
      if (picked === null) {
        return;
      }
      props.onMoveTask(picked.task);
    }
  });

  if (!data.loaded) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.muted}>Loading tasks...</Text>
      </Box>
    );
  }

  if (data.error !== null) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.error}>Failed to load tasks: {data.error}</Text>
        <Text color={theme.muted}>Esc to return</Text>
      </Box>
    );
  }

  // Pick a column width that fits all visible columns side-by-side.
  const columnCount = VISIBLE_COLUMNS.length;
  const columnWidth = Math.max(16, Math.floor(terminalWidth / columnCount));

  return (
    <Box flexDirection="column" width={terminalWidth}>
      <Box flexDirection="row" paddingX={1}>
        <Text color={theme.primary}>Tasks</Text>
        <Text color={theme.muted}> — {props.projectRoot}</Text>
      </Box>
      <Box flexDirection="row">
        {VISIBLE_COLUMNS.map((column, columnIndex) => {
          const bucket = buckets.get(column) ?? [];
          const isSelectedColumn = columnIndex === selection.columnIndex;
          return (
            <Box
              key={column}
              flexDirection="column"
              width={columnWidth}
              borderStyle="single"
              borderColor={isSelectedColumn ? theme.primary : theme.border}
            >
              <Box paddingX={1}>
                <Text color={isSelectedColumn ? theme.primary : theme.accent}>
                  {columnLabel(column)} ({bucket.length})
                </Text>
              </Box>
              {bucket.length === 0 ? (
                <Box paddingX={1}>
                  <Text color={theme.muted}>—</Text>
                </Box>
              ) : (
                bucket.map((item, rowIndex) => {
                  const isSelected = isSelectedColumn && rowIndex === selection.rowIndex;
                  return (
                    <TaskCard
                      key={item.task.id}
                      task={item.task}
                      selected={isSelected}
                      isStructured={item.isStructured}
                    />
                  );
                })
              )}
            </Box>
          );
        })}
      </Box>
      <Box paddingX={1}>
        <Text color={theme.muted}>↑↓←→ navigate • Enter open • c create • m move • Esc exit</Text>
      </Box>
    </Box>
  );
}

//#endregion
