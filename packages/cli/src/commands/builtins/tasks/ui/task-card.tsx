/**
 * Single kanban card. Renders the task title, source badge, and status icon.
 * Highlights when selected and decorates structured tasks with a hierarchy
 * indicator.
 */

import type { Task } from '@noetic/code-agent/tasks/schema';
import { TaskSource } from '@noetic/code-agent/tasks/schema';
import { Box, Text } from 'ink';
import type React from 'react';
import { useTheme } from '../../../../tui/components/theme.js';

//#region Types

export interface TaskCardProps {
  task: Task;
  selected: boolean;
  /** Set when the task carries a `hierarchy/` subtree (structured task). */
  isStructured: boolean;
}

//#endregion

//#region Helpers

/**
 * Source badge shown as `[m]` (manual) or `[w]` (worktree). Pure helper so
 * tests can assert the mapping without rendering Ink.
 */
export function sourceBadge(source: Task['source']): string {
  if (source === TaskSource.Worktree) {
    return '[w]';
  }
  return '[m]';
}

/** Return the hierarchy indicator glyph or empty string for leaf tasks. */
export function hierarchyIcon(isStructured: boolean): string {
  return isStructured ? ' ▾' : '';
}

/** Tiny lifecycle/review status glyph for the card. */
export function statusIcon(task: Task): string {
  if (task.paused) {
    return '‖';
  }
  if (task.archivedAt !== null) {
    return '✕';
  }
  return '●';
}

//#endregion

//#region Component

export function TaskCard({ task, selected, isStructured }: TaskCardProps): React.ReactElement {
  const theme = useTheme();
  const accent = selected ? theme.primary : theme.muted;
  const titleColor = selected ? theme.primary : theme.foreground;
  return (
    <Box flexDirection="row" paddingX={1}>
      <Box width={2} flexShrink={0}>
        <Text color={accent}>{selected ? '>' : ' '}</Text>
      </Box>
      <Box width={4} flexShrink={0}>
        <Text color={theme.muted}>{sourceBadge(task.source)}</Text>
      </Box>
      <Box width={2} flexShrink={0}>
        <Text color={accent}>{statusIcon(task)}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        <Text color={titleColor} wrap="truncate-end">
          {task.title}
          {hierarchyIcon(isStructured)}
        </Text>
      </Box>
    </Box>
  );
}

//#endregion
