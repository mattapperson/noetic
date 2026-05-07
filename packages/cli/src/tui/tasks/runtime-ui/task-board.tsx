/**
 * Full-screen kanban board view. The exported `TaskBoard` is a host that
 * switches between five sub-views — kanban, create, move, detail,
 * hierarchy — and routes the keyboard focus to whichever is active.
 *
 * `KanbanView` is the inner kanban grid. It loads every task, lays them out
 * by `deriveColumn`, and dispatches `c`/`m`/`Enter` to host-supplied
 * callbacks. The host owns the mode state so each sub-view's `useInput`
 * has exclusive ownership while it's mounted.
 *
 * Pure helpers (`groupTasksByColumn`, `selectionAfterKey`, etc.) are
 * exported so unit tests can exercise the navigation/grouping logic
 * without rendering Ink.
 */

import type { Task } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { hasHierarchy, listTasks } from '@noetic/code-agent/tasks/store/fs-node';
import type { FsAdapter } from '@noetic/core';
import { Box, Text, useInput, useStdout } from 'ink';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { deriveColumn, KanbanColumn } from '../../../tasks/runtime/kanban.js';
import { useTheme } from '../../components/theme.js';
import { columnLabel, VISIBLE_COLUMNS } from './columns.js';
import { TaskCard } from './task-card.js';
import { TaskCreateForm } from './task-create-form.js';
import { TaskDetail } from './task-detail.js';
import { TaskHierarchyView } from './task-hierarchy-view.js';
import { TaskMovePicker } from './task-move-picker.js';
import { useEventsTail } from './use-events-tail.js';

//#region Types

export interface TaskBoardProps {
  /** Project root holding `.noetic/tasks/`. */
  projectRoot: string;
  /** FS adapter used to load tasks. */
  fs: FsAdapter;
  /** Called when the user presses `Esc` from the kanban to leave the board. */
  onExit: () => void;
  /**
   * Called from a task's detail view when the user presses `c` to chat
   * with that task's running agent. The host (app.tsx) is responsible
   * for resolving the IPC socket and switching viewMode.
   */
  onOpenChat?: (task: Task) => void;
}

interface KanbanViewProps {
  readonly projectRoot: string;
  readonly fs: FsAdapter;
  /** Bumped after a sub-view persists a change so the kanban re-fetches. */
  readonly refreshNonce: number;
  readonly onExit: () => void;
  readonly onOpenTask: (task: Task) => void;
  readonly onOpenHierarchy: (task: Task) => void;
  readonly onCreateTask: () => void;
  readonly onMoveTask: (task: Task) => void;
}

type Mode =
  | {
      readonly kind: 'kanban';
    }
  | {
      readonly kind: 'create';
    }
  | {
      readonly kind: 'move';
      readonly task: Task;
    }
  | {
      readonly kind: 'detail';
      readonly task: Task;
    }
  | {
      readonly kind: 'hierarchy';
      readonly task: Task;
    };

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

/** Minimum per-column width below which the kanban looks unreadable. */
const MIN_COLUMN_WIDTH = 16;

export { columnLabel, VISIBLE_COLUMNS };

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
  readonly visibleColumns?: ReadonlyArray<KanbanColumn>;
}

/**
 * Compute the next selection after a directional key. Empty columns are
 * skipped on horizontal moves so the user can never land on a column
 * with no rows. Vertical moves clamp at the column's bounds.
 */
export function selectionAfterKey(input: NavInput): BoardSelection {
  const cols = input.visibleColumns ?? VISIBLE_COLUMNS;
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
  visibleColumns: ReadonlyArray<KanbanColumn> = VISIBLE_COLUMNS,
): DecoratedTask | null {
  const colKey = visibleColumns[selection.columnIndex];
  if (colKey === undefined) {
    return null;
  }
  const bucket = buckets.get(colKey) ?? [];
  return bucket[selection.rowIndex] ?? null;
}

/**
 * Subscribe to terminal resize events so the layout re-renders on resize.
 * Ink's `useStdout` returns the stdout handle but does not subscribe; we
 * have to listen for `resize` ourselves and update local state.
 */
function useTerminalDimensions(): {
  cols: number;
  rows: number;
} {
  const { stdout } = useStdout();
  const [dims, setDims] = useState({
    cols: stdout?.columns ?? 100,
    rows: stdout?.rows ?? 24,
  });
  useEffect(() => {
    if (!stdout) {
      return;
    }
    const handler = (): void => {
      setDims({
        cols: stdout.columns,
        rows: stdout.rows,
      });
    };
    stdout.on('resize', handler);
    return (): void => {
      stdout.off('resize', handler);
    };
  }, [
    stdout,
  ]);
  return dims;
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

//#region Kanban inner view

function KanbanView(props: KanbanViewProps): React.ReactElement {
  const theme = useTheme();
  const { cols: terminalWidth } = useTerminalDimensions();
  const [data, setData] = useState<BoardData>(EMPTY_BOARD_DATA);
  const [selection, setSelection] = useState<BoardSelection>({
    columnIndex: 0,
    rowIndex: 0,
  });

  const visibleColumns = VISIBLE_COLUMNS;

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

  // Re-load on mount, on every event-tail bump, and after a sub-view persists
  // a change (refreshNonce). Reading `revision` and `refreshNonce` so the
  // effect closure depends on both; the values themselves aren't used.
  useEffect(() => {
    void revision;
    void props.refreshNonce;
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
    props.refreshNonce,
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
          visibleColumns,
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
      const picked = selectedTask(buckets, selection, visibleColumns);
      if (picked === null) {
        return;
      }
      if (picked.isStructured) {
        props.onOpenHierarchy(picked.task);
        return;
      }
      props.onOpenTask(picked.task);
      return;
    }
    if (input === 'c') {
      props.onCreateTask();
      return;
    }
    if (input === 'm') {
      const picked = selectedTask(buckets, selection, visibleColumns);
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
  const columnCount = visibleColumns.length;
  const columnWidth = Math.max(MIN_COLUMN_WIDTH, Math.floor(terminalWidth / columnCount));

  return (
    <Box flexDirection="column" width={terminalWidth}>
      <Box flexDirection="row" paddingX={1}>
        <Text color={theme.primary}>Tasks</Text>
        <Text color={theme.muted}> — {props.projectRoot}</Text>
      </Box>
      <Box flexDirection="row">
        {visibleColumns.map((column, columnIndex) => {
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

//#region Host component

/**
 * TaskBoard host — owns the active sub-view mode and routes between the
 * kanban grid and the create / move / detail / hierarchy sub-views. Each
 * sub-view's `useInput` runs in isolation because only one is mounted at
 * a time.
 */
export function TaskBoard(props: TaskBoardProps): React.ReactElement {
  const [mode, setMode] = useState<Mode>({
    kind: 'kanban',
  });
  const [refreshNonce, setRefreshNonce] = useState(0);

  const returnToKanban = useCallback((): void => {
    setMode({
      kind: 'kanban',
    });
  }, []);

  const returnAndRefresh = useCallback((): void => {
    setRefreshNonce((n) => n + 1);
    setMode({
      kind: 'kanban',
    });
  }, []);

  if (mode.kind === 'create') {
    return (
      <TaskCreateForm
        fs={props.fs}
        projectRoot={props.projectRoot}
        onCreated={returnAndRefresh}
        onCancel={returnToKanban}
      />
    );
  }
  if (mode.kind === 'move') {
    return (
      <TaskMovePicker
        fs={props.fs}
        projectRoot={props.projectRoot}
        task={mode.task}
        onMoved={returnAndRefresh}
        onCancel={returnToKanban}
      />
    );
  }
  if (mode.kind === 'detail') {
    const taskForDetail = mode.task;
    return (
      <TaskDetail
        fs={props.fs}
        projectRoot={props.projectRoot}
        task={taskForDetail}
        onClose={returnToKanban}
        onOpenChat={
          props.onOpenChat
            ? (): void => {
                props.onOpenChat?.(taskForDetail);
              }
            : undefined
        }
      />
    );
  }
  if (mode.kind === 'hierarchy') {
    return (
      <TaskHierarchyView
        fs={props.fs}
        projectRoot={props.projectRoot}
        task={mode.task}
        onClose={returnToKanban}
      />
    );
  }
  return (
    <KanbanView
      fs={props.fs}
      projectRoot={props.projectRoot}
      refreshNonce={refreshNonce}
      onExit={props.onExit}
      onOpenTask={(task): void =>
        setMode({
          kind: 'detail',
          task,
        })
      }
      onOpenHierarchy={(task): void =>
        setMode({
          kind: 'hierarchy',
          task,
        })
      }
      onCreateTask={(): void =>
        setMode({
          kind: 'create',
        })
      }
      onMoveTask={(task): void =>
        setMode({
          kind: 'move',
          task,
        })
      }
    />
  );
}

//#endregion
