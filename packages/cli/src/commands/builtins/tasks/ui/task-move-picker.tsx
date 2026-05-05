/**
 * Modal column picker for moving a task between kanban columns. Up/Down
 * scroll the list, Enter commits the move via `moveTask`, Esc cancels.
 *
 * The mutation hook is exposed as `commitMove` for unit testing.
 */

import type { Task } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import type { FsAdapter } from '@noetic/core';
import { Box, Text, useInput } from 'ink';
import type { ReactElement } from 'react';
import { useCallback, useState } from 'react';
import { useTheme } from '../../../../tui/components/theme.js';
import { moveTaskHandler } from '../handlers/state.js';
import type { KanbanColumn } from '../kanban.js';
import { deriveColumn } from '../kanban.js';
import { columnLabel, VISIBLE_COLUMNS } from './columns.js';

//#region Types

export interface TaskMovePickerProps {
  task: Task;
  fs: FsAdapter;
  projectRoot: string;
  /** Called after a successful move with the freshly-saved Task. */
  onMoved: (task: Task) => void;
  /** Called when the user presses `Esc`. */
  onCancel: () => void;
}

export interface CommitMoveInput {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly column: KanbanColumn;
  /**
   * Override the reconciler-owned-column guard. Required to move into
   * `removed` or `cleanup_blocked` (these columns are normally only
   * reached by the daemon's reconcile pass).
   */
  readonly force?: boolean;
}

//#endregion

//#region Helpers

/**
 * Move a task via the canonical {@link moveTaskHandler}. The handler
 * owns the reconciler-owned-column guard and emits the `task:moved`
 * event with both `previousColumn` and `column` in the payload, so
 * TUI moves and CLI moves produce identical event shapes.
 */
export async function commitMove(input: CommitMoveInput): Promise<Task> {
  const result = await moveTaskHandler(input.ctx, {
    taskId: input.taskId,
    column: input.column,
    force: input.force,
  });
  return result.task;
}

/** Pure clamp helper: nudge `cursor` by `delta`, clipping to `[0, max]`. */
export function clampCursor(cursor: number, delta: number, max: number): number {
  if (max <= 0) {
    return 0;
  }
  const next = cursor + delta;
  if (next < 0) {
    return 0;
  }
  if (next > max) {
    return max;
  }
  return next;
}

//#endregion

//#region Component

export function TaskMovePicker(props: TaskMovePickerProps): ReactElement {
  const theme = useTheme();
  const currentColumn = deriveColumn(props.task);
  const [cursor, setCursor] = useState(() => {
    const idx = VISIBLE_COLUMNS.indexOf(currentColumn);
    return idx === -1 ? 0 : idx;
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(
    async (column: KanbanColumn): Promise<void> => {
      if (submitting) {
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        const next = await commitMove({
          ctx: {
            fs: props.fs,
            projectRoot: props.projectRoot,
          },
          taskId: props.task.id,
          column,
        });
        props.onMoved(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setSubmitting(false);
      }
    },
    [
      submitting,
      props,
    ],
  );

  useInput((_input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => clampCursor(c, -1, VISIBLE_COLUMNS.length - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => clampCursor(c, 1, VISIBLE_COLUMNS.length - 1));
      return;
    }
    if (key.return) {
      const column = VISIBLE_COLUMNS[cursor];
      if (column === undefined) {
        return;
      }
      void submit(column);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor={theme.border}>
      <Text color={theme.primary}>Move "{props.task.title}"</Text>
      <Text color={theme.muted}>Currently: {columnLabel(currentColumn)}</Text>

      <Box marginTop={1} flexDirection="column">
        {VISIBLE_COLUMNS.map((column, idx) => {
          const selected = idx === cursor;
          const marker = selected ? '>' : ' ';
          const color = selected ? theme.primary : theme.foreground;
          return (
            <Box key={column}>
              <Text color={color}>
                {marker} {columnLabel(column)}
              </Text>
            </Box>
          );
        })}
      </Box>

      {error !== null ? (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.muted}>
          {submitting ? 'Moving...' : '↑↓ select • Enter confirm • Esc cancel'}
        </Text>
      </Box>
    </Box>
  );
}

//#endregion
