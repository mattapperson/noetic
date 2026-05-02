/**
 * Detail view for a leaf task. Loads the description, the tail of
 * `log.jsonl`, and the contents of `attachments/` (just file names —
 * the user can open them externally).
 *
 * Esc returns to the kanban. Pure helpers (`formatLogLine`,
 * `truncateLogTail`) are exported so they can be unit-tested without
 * rendering Ink.
 */

import type { FsAdapter } from '@noetic/core';
import { Box, Text, useInput } from 'ink';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';

import { useTheme } from '../../../../tui/components/theme.js';
import { isEnoent } from '../_fs-errors.js';
import type { TaskStoreContext } from '../fs-store.js';
import { tailLog } from '../fs-store.js';
import { taskDirPaths } from '../paths.js';
import type { LogEntry, Task } from '../schemas.js';

//#region Types

export interface TaskDetailProps {
  task: Task;
  /** FS adapter used to read the task directory. */
  fs: FsAdapter;
  /** Project root holding `.noetic/tasks/<taskId>/`. */
  projectRoot: string;
  /** Called when the user presses `Esc` to return to the board. */
  onClose: () => void;
  /** Called when the user presses `c` to chat with the task's running agent. */
  onOpenChat?: () => void;
  /** Maximum log entries to tail. Defaults to 25. */
  logLimit?: number;
}

interface DetailData {
  readonly description: string;
  readonly logEntries: ReadonlyArray<LogEntry>;
  readonly attachments: ReadonlyArray<string>;
  readonly error: string | null;
  readonly loaded: boolean;
}

//#endregion

//#region Helpers

const EMPTY_DETAIL_DATA: DetailData = {
  description: '',
  logEntries: [],
  attachments: [],
  error: null,
  loaded: false,
};

/**
 * Format a single log line for terminal display:
 * `<HH:MM:SS> [kind] message`. Pure helper exported for tests.
 */
export function formatLogLine(entry: LogEntry): string {
  const ts = entry.ts.length >= 19 ? entry.ts.slice(11, 19) : entry.ts;
  return `${ts} [${entry.kind}] ${entry.message}`;
}

/**
 * Compose a stable React key for a log row. Combines `ts`, `chunk`
 * (when set), and a prefix of the message so duplicate-timestamp rows
 * still get distinct keys without resorting to the array index.
 */
export function logEntryKey(entry: LogEntry): string {
  const chunk = entry.chunk ?? 0;
  const head = entry.message.slice(0, 32);
  return `${entry.ts}#${chunk}#${head}`;
}

/**
 * Slice the most recent `n` entries from `entries`. Pure helper kept
 * separate so the rendering path stays straight-line.
 */
export function truncateLogTail(
  entries: ReadonlyArray<LogEntry>,
  n: number,
): ReadonlyArray<LogEntry> {
  if (entries.length <= n) {
    return entries;
  }
  return entries.slice(entries.length - n);
}

async function readDescription(opts: {
  fs: FsAdapter;
  projectRoot: string;
  taskId: string;
}): Promise<string> {
  const paths = taskDirPaths(opts.projectRoot, opts.taskId);
  try {
    return await opts.fs.readFileText(paths.description);
  } catch (err) {
    if (isEnoent(err)) {
      return '';
    }
    throw err;
  }
}

async function readAttachments(opts: {
  fs: FsAdapter;
  projectRoot: string;
  taskId: string;
}): Promise<string[]> {
  const paths = taskDirPaths(opts.projectRoot, opts.taskId);
  try {
    return await opts.fs.readdir(paths.attachments);
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }
}

async function loadDetailData(opts: {
  ctx: TaskStoreContext;
  taskId: string;
  logLimit: number;
}): Promise<DetailData> {
  try {
    const [description, logEntries, attachments] = await Promise.all([
      readDescription({
        fs: opts.ctx.fs,
        projectRoot: opts.ctx.projectRoot,
        taskId: opts.taskId,
      }),
      tailLog(opts.ctx, {
        taskId: opts.taskId,
        n: opts.logLimit,
      }),
      readAttachments({
        fs: opts.ctx.fs,
        projectRoot: opts.ctx.projectRoot,
        taskId: opts.taskId,
      }),
    ]);
    return {
      description,
      logEntries,
      attachments,
      error: null,
      loaded: true,
    };
  } catch (err) {
    return {
      description: '',
      logEntries: [],
      attachments: [],
      error: err instanceof Error ? err.message : String(err),
      loaded: true,
    };
  }
}

//#endregion

//#region Component

export function TaskDetail(props: TaskDetailProps): React.ReactElement {
  const theme = useTheme();
  const [data, setData] = useState<DetailData>(EMPTY_DETAIL_DATA);
  const logLimit = props.logLimit ?? 25;

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

  useEffect(() => {
    let cancelled = false;
    void loadDetailData({
      ctx,
      taskId: props.task.id,
      logLimit,
    }).then((next) => {
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
    props.task.id,
    logLimit,
  ]);

  useInput((input, key) => {
    if (key.escape) {
      props.onClose();
      return;
    }
    if (input === 'c' && props.onOpenChat) {
      props.onOpenChat();
    }
  });

  if (!data.loaded) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.muted}>Loading task {props.task.id}...</Text>
      </Box>
    );
  }

  if (data.error !== null) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.error}>Failed to load task: {data.error}</Text>
        <Text color={theme.muted}>Esc to return</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text color={theme.primary}>{props.task.title}</Text>
        <Text color={theme.muted}> — {props.task.id}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.accent}>Description</Text>
        {data.description.length > 0 ? (
          <Text>{data.description}</Text>
        ) : (
          <Text color={theme.muted}>(no description)</Text>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.accent}>Log (last {logLimit})</Text>
        {data.logEntries.length === 0 ? (
          <Text color={theme.muted}>(empty)</Text>
        ) : (
          truncateLogTail(data.logEntries, logLimit).map((entry) => (
            <Text key={logEntryKey(entry)} wrap="truncate-end">
              {formatLogLine(entry)}
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={theme.accent}>Attachments</Text>
        {data.attachments.length === 0 ? (
          <Text color={theme.muted}>(none)</Text>
        ) : (
          data.attachments.map((name) => (
            <Text key={name} wrap="truncate-end">
              · {name}
            </Text>
          ))
        )}
      </Box>

      <Box marginTop={1}>
        <Text color={theme.muted}>
          Esc to return{props.onOpenChat ? '  ·  c to chat with agent' : ''}
        </Text>
      </Box>
    </Box>
  );
}

//#endregion
