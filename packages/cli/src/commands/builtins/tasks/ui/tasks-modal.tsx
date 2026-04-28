import { Box, Text, useInput, useStdout } from 'ink';
import type { ReactNode } from 'react';
import { useState } from 'react';

import type { Theme } from '../../../../tui/components/theme.js';
import { useTheme } from '../../../../tui/components/theme.js';
import type { TaskTableRow } from '../store.js';

export interface TasksModalProps {
  projectRoot: string;
  databasePath: string;
  rows: TaskTableRow[];
  error?: string;
  lastResult?: string | null;
  onClose: () => void;
  onCancel?: (row: TaskTableRow) => void;
  onTogglePause?: (row: TaskTableRow) => void;
}

const MARKER_WIDTH = 2;
const SESSIONS_WIDTH = 8;
const REVIEW_WIDTH = 14;
const CI_WIDTH = 12;
const PATH_BREAKPOINT = 100;
const MIN_TITLE_BASIS = 16;
const MIN_BRANCH_BASIS = 12;
const MIN_PATH_BASIS = 18;

export function TasksModal(props: TasksModalProps): ReactNode {
  const { projectRoot, databasePath, rows, error, lastResult, onClose, onCancel, onTogglePause } =
    props;
  const theme = useTheme();
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns ?? 100;
  const terminalHeight = stdout?.rows ?? 28;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const showPath = terminalWidth >= PATH_BREAKPOINT;

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose();
      return;
    }
    if (key.upArrow || input === 'k') {
      setSelectedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex((current) => Math.min(Math.max(0, rows.length - 1), current + 1));
      return;
    }
    const selected = rows[selectedIndex];
    if (selected === undefined) {
      return;
    }
    if (selected.agentCiStatus === 'unavailable') {
      return;
    }
    if (input === 'c' && onCancel !== undefined) {
      onCancel(selected);
      return;
    }
    if (input === 'p' && onTogglePause !== undefined) {
      onTogglePause(selected);
    }
  });

  const visibleCount = Math.max(1, terminalHeight - 12);
  const start = Math.max(
    0,
    Math.min(
      Math.max(0, selectedIndex - visibleCount + 1),
      Math.max(0, rows.length - visibleCount),
    ),
  );
  const visibleRows = rows.slice(start, start + visibleCount);

  if (error !== undefined) {
    return (
      <Box flexDirection="column" borderStyle="single" borderColor={theme.error} paddingX={1}>
        <Text color={theme.error}>Tasks failed</Text>
        <Text>{error}</Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.border}
      paddingX={1}
      width={terminalWidth}
    >
      <Box flexDirection="column" marginBottom={1}>
        <Text color={theme.primary}>Tasks</Text>
        <Text dimColor wrap="truncate-start">
          {projectRoot}
        </Text>
        <Text dimColor wrap="truncate-start">
          {databasePath}
        </Text>
      </Box>

      <HeaderRow theme={theme} showPath={showPath} />

      {visibleRows.map((row, idx) => {
        const absoluteIndex = start + idx;
        const selected = absoluteIndex === selectedIndex;
        return (
          <TaskRow key={row.id} row={row} selected={selected} theme={theme} showPath={showPath} />
        );
      })}

      {rows.length === 0 ? <Text dimColor>No worktrees found</Text> : null}

      {lastResult !== undefined && lastResult !== null ? (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {lastResult}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>c cancel • p pause/resume • q close</Text>
      </Box>
    </Box>
  );
}

interface HeaderRowProps {
  theme: Theme;
  showPath: boolean;
}

function HeaderRow({ theme, showPath }: HeaderRowProps): ReactNode {
  return (
    <Box flexDirection="row">
      <Box width={MARKER_WIDTH} flexShrink={0} />
      <Box flexGrow={2} flexShrink={1} flexBasis={MIN_TITLE_BASIS}>
        <Text color={theme.accent} wrap="truncate-end">
          Task
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexBasis={MIN_BRANCH_BASIS} marginLeft={1}>
        <Text color={theme.accent} wrap="truncate-end">
          Branch
        </Text>
      </Box>
      <Box width={SESSIONS_WIDTH} flexShrink={0} marginLeft={1} justifyContent="flex-end">
        <Text color={theme.accent}>Sessions</Text>
      </Box>
      <Box width={REVIEW_WIDTH} flexShrink={0} marginLeft={1}>
        <Text color={theme.accent} wrap="truncate-end">
          Review
        </Text>
      </Box>
      <Box width={CI_WIDTH} flexShrink={0} marginLeft={1}>
        <Text color={theme.accent} wrap="truncate-end">
          CI
        </Text>
      </Box>
      {showPath ? (
        <Box flexGrow={2} flexShrink={1} flexBasis={MIN_PATH_BASIS} marginLeft={1}>
          <Text color={theme.accent} wrap="truncate-end">
            Path
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

interface TaskRowProps {
  row: TaskTableRow;
  selected: boolean;
  theme: Theme;
  showPath: boolean;
}

function TaskRow({ row, selected, theme, showPath }: TaskRowProps): ReactNode {
  const color = selected ? theme.primary : undefined;
  const marker = selected ? '>' : row.current ? '*' : ' ';
  const branch = row.branch ?? 'detached';
  const review = row.reviewStatus.replace(/_/g, ' ');
  const ciLabel = formatAgentCiLabel(row);

  return (
    <Box flexDirection="row">
      <Box width={MARKER_WIDTH} flexShrink={0}>
        <Text color={color}>{marker}</Text>
      </Box>
      <Box flexGrow={2} flexShrink={1} flexBasis={MIN_TITLE_BASIS}>
        <Text color={color} wrap="truncate-end">
          {row.title}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexBasis={MIN_BRANCH_BASIS} marginLeft={1}>
        <Text color={color} wrap="truncate-end">
          {branch}
        </Text>
      </Box>
      <Box width={SESSIONS_WIDTH} flexShrink={0} marginLeft={1} justifyContent="flex-end">
        <Text color={color}>{row.sessionsCount}</Text>
      </Box>
      <Box width={REVIEW_WIDTH} flexShrink={0} marginLeft={1}>
        <Text color={color} wrap="truncate-end">
          {review}
        </Text>
      </Box>
      <Box width={CI_WIDTH} flexShrink={0} marginLeft={1}>
        <Text color={color} wrap="truncate-end">
          {ciLabel}
        </Text>
      </Box>
      {showPath ? (
        <Box flexGrow={2} flexShrink={1} flexBasis={MIN_PATH_BASIS} marginLeft={1}>
          <Text color={color} wrap="truncate-start">
            {row.worktreePath}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function formatAgentCiLabel(row: TaskTableRow): string {
  if (row.agentCiStatus === 'running') {
    return '▶ running';
  }
  if (row.agentCiStatus === 'paused') {
    return '‖ paused';
  }
  return '';
}
