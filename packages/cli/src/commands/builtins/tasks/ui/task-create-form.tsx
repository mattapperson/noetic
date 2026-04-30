/**
 * Inline form for creating a manual task. Two text fields (title,
 * description); Tab cycles focus, Enter on the title field moves to the
 * description, Enter on the description submits, Esc cancels.
 *
 * On submit, the form persists `task.json`, optionally writes
 * `description.md`, and appends a `task:created` event to
 * `_events.jsonl`. The kanban hook tails the events file (and watches
 * its size watermark) and re-renders when it grows.
 *
 * The persistence logic is exposed as `submitNewTask` so unit tests
 * can drive it without rendering Ink.
 */

import type { FsAdapter } from '@noetic/core';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type React from 'react';
import { useCallback, useState } from 'react';

import { useTheme } from '../../../../tui/components/theme.js';
import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent, saveTask } from '../fs-store.js';
import { taskDirPaths } from '../paths.js';
import type { Task } from '../schemas.js';
import {
  AutopilotState,
  generateTaskId,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '../schemas.js';

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
type FocusedField = typeof FIELD_TITLE | typeof FIELD_DESCRIPTION;

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
 * event. Returns the freshly-saved record.
 *
 * Order: write `task.json` → write `description.md` (if any) → append
 * `_events.jsonl` → emit in-process. The on-disk write happens before
 * the event so any tailer reading the events file finds the row already
 * present.
 */
export async function submitNewTask(input: SubmitNewTaskInput): Promise<Task> {
  const trimmedTitle = input.title.trim();
  if (trimmedTitle.length === 0) {
    throw new Error('Title is required');
  }
  const task = buildManualTask({
    title: trimmedTitle,
    projectRoot: input.ctx.projectRoot,
  });
  await saveTask(input.ctx, task);
  if (input.description.trim().length > 0) {
    const paths = taskDirPaths(input.ctx.projectRoot, task.id);
    await input.ctx.fs.mkdir(paths.dir);
    await input.ctx.fs.writeFile(paths.description, input.description);
  }
  await appendEvent(input.ctx, {
    taskId: task.id,
    kind: 'task:created',
    ts: new Date().toISOString(),
  });
  return task;
}

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

  useInput((_input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (key.tab) {
      setFocused((current) => (current === FIELD_TITLE ? FIELD_DESCRIPTION : FIELD_TITLE));
    }
  });

  const handleTitleSubmit = useCallback((): void => {
    setFocused(FIELD_DESCRIPTION);
  }, []);

  const handleDescriptionSubmit = useCallback((): void => {
    void submit();
  }, [
    submit,
  ]);

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor={theme.border}>
      <Text color={theme.primary}>New Task</Text>

      <Box marginTop={1} flexDirection="column">
        <Text color={focused === FIELD_TITLE ? theme.primary : theme.muted}>Title</Text>
        <TextInput
          value={title}
          onChange={setTitle}
          onSubmit={handleTitleSubmit}
          focus={focused === FIELD_TITLE}
          placeholder="Short summary..."
        />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={focused === FIELD_DESCRIPTION ? theme.primary : theme.muted}>Description</Text>
        <TextInput
          value={description}
          onChange={setDescription}
          onSubmit={handleDescriptionSubmit}
          focus={focused === FIELD_DESCRIPTION}
          placeholder="Long-form details..."
        />
      </Box>

      {error !== null ? (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.muted}>
          {submitting ? 'Saving...' : 'Tab switches fields • Enter advances/saves • Esc cancels'}
        </Text>
      </Box>
    </Box>
  );
}

//#endregion
