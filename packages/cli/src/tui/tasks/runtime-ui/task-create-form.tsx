/**
 * Inline form for creating a manual task. Two text fields (title,
 * description) and a focusable Submit button. Tab/Shift+Tab cycle focus
 * through the three controls. Enter is reserved for inserting newlines in
 * the description; the form only saves when Submit is focused and Enter or
 * Space is pressed. Esc cancels.
 *
 * On submit, the form persists `task.json`, writes `description.md`, and
 * appends a `task:created` event to `_events.jsonl`. Both title and
 * description are required — empty values are rejected with a descriptive
 * error. The kanban hook tails the events file (and watches its size
 * watermark) and re-renders when it grows.
 *
 * The persistence logic is exposed as `submitNewTask` so unit tests
 * can drive it without rendering Ink.
 */

import type { Task } from '@noetic/code-agent/tasks/schema';
import {
  AutopilotState,
  generateTaskId,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { appendEvent, saveTask, taskDirPaths } from '@noetic/code-agent/tasks/store/fs-node';
import type { FsAdapter } from '@noetic-tools/core';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type React from 'react';
import { useCallback, useState } from 'react';
import { useTheme } from '../../components/theme.js';
import { MultilineTextArea } from './multiline-text-area.js';

//#region Types

export interface TaskCreateFormProps {
  fs: FsAdapter;
  projectRoot: string;
  /** Called when the form is submitted with the freshly-saved Task. */
  onCreated: (task: Task) => void;
  /** Called when the user presses `Esc`. */
  onCancel: () => void;
}

export interface SubmitNewTaskInput {
  readonly ctx: TaskStoreContext;
  readonly title: string;
  readonly description: string;
}

//#endregion

//#region Helpers

const FIELD_TITLE = 'title' as const;
const FIELD_DESCRIPTION = 'description' as const;
const FIELD_SUBMIT = 'submit' as const;
type FocusedField = typeof FIELD_TITLE | typeof FIELD_DESCRIPTION | typeof FIELD_SUBMIT;

const FOCUS_ORDER: ReadonlyArray<FocusedField> = [
  FIELD_TITLE,
  FIELD_DESCRIPTION,
  FIELD_SUBMIT,
];

function nextFocus(current: FocusedField, direction: 1 | -1): FocusedField {
  const index = FOCUS_ORDER.indexOf(current);
  const length = FOCUS_ORDER.length;
  const nextIndex = (index + direction + length) % length;
  const nextField = FOCUS_ORDER[nextIndex];
  return nextField === undefined ? FIELD_TITLE : nextField;
}

/** Build a fully-defaulted `Task` record. Pure helper for unit tests. */
export function buildManualTask(opts: { title: string; projectRoot: string }): Task {
  const now = new Date().toISOString();
  return {
    id: generateTaskId(),
    source: TaskSource.Manual,
    title: opts.title,
    projectRoot: opts.projectRoot,
    worktreePath: null,
    branch: null,
    headSha: null,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: false,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
}

/**
 * Persist a new manual task and emit the corresponding `task:created`
 * event. Returns the freshly-saved record. Both title and description
 * are required.
 *
 * Order: write `task.json` → write `description.md` → append
 * `_events.jsonl` → emit in-process. The on-disk write happens before
 * the event so any tailer reading the events file finds the row already
 * present.
 */
export async function submitNewTask(input: SubmitNewTaskInput): Promise<Task> {
  const trimmedTitle = input.title.trim();
  if (trimmedTitle.length === 0) {
    throw new Error('Title is required');
  }
  if (input.description.trim().length === 0) {
    throw new Error('Description is required');
  }
  const task = buildManualTask({
    title: trimmedTitle,
    projectRoot: input.ctx.projectRoot,
  });
  await saveTask(input.ctx, task);
  const paths = taskDirPaths(input.ctx, task.id);
  await input.ctx.fs.writeFile(paths.description, input.description);
  await appendEvent(input.ctx, {
    taskId: task.id,
    kind: 'task:created',
    ts: new Date().toISOString(),
  });
  return task;
}

function noop(): void {}

//#endregion

//#region Component

export function TaskCreateForm(props: TaskCreateFormProps): React.ReactElement {
  const theme = useTheme();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [focused, setFocused] = useState<FocusedField>(FIELD_TITLE);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(async (): Promise<void> => {
    if (submitting) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const task = await submitNewTask({
        ctx: {
          fs: props.fs,
          projectRoot: props.projectRoot,
        },
        title,
        description,
      });
      props.onCreated(task);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }, [
    submitting,
    title,
    description,
    props,
  ]);

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.tab) {
      setFocused((current) => nextFocus(current, key.shift ? -1 : 1));
      return;
    }
    if (focused !== FIELD_SUBMIT) {
      return;
    }
    if (key.return || input === ' ') {
      void submit();
    }
  });

  const submitColor = focused === FIELD_SUBMIT ? theme.primary : theme.muted;
  const submitLabel = submitting ? 'Saving...' : 'Submit';

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor={theme.border}>
      <Text color={theme.primary}>New Task</Text>

      <Box marginTop={1} flexDirection="column">
        <Text color={focused === FIELD_TITLE ? theme.primary : theme.muted}>Title</Text>
        <TextInput
          value={title}
          onChange={setTitle}
          onSubmit={noop}
          focus={focused === FIELD_TITLE}
          placeholder="Short summary..."
        />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={focused === FIELD_DESCRIPTION ? theme.primary : theme.muted}>Description</Text>
        <MultilineTextArea
          value={description}
          onChange={setDescription}
          focus={focused === FIELD_DESCRIPTION}
          placeholder="Long-form details..."
        />
      </Box>

      <Box marginTop={1}>
        <Box borderStyle="round" borderColor={submitColor} paddingX={1}>
          <Text color={submitColor} bold={focused === FIELD_SUBMIT}>
            {submitLabel}
          </Text>
        </Box>
      </Box>

      {error !== null ? (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.muted}>
          Tab navigates • Enter inserts newline • Tab to Submit, then Enter/Space • Esc cancels
        </Text>
      </Box>
    </Box>
  );
}

//#endregion
