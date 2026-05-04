import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent, saveTask } from '../fs-store.js';
import { taskDirPaths } from '../paths.js';
import type { Task } from '../schemas.js';
import {
  AutopilotState,
  EventKind,
  generateTaskId,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '../schemas.js';
import { nowIso } from './_shared.js';

//#region Types

export interface CreateTaskArgs {
  readonly title: string;
  readonly description?: string;
}

export interface CreateTaskResult {
  readonly task: Task;
}

//#endregion

//#region Public API

/**
 * Create a fresh manual task: write `task.json`, optionally seed
 * `description.md`, append a `task:created` event, and fan out the
 * in-process notification.
 */
export async function createTaskHandler(
  ctx: TaskStoreContext,
  args: CreateTaskArgs,
): Promise<CreateTaskResult> {
  const trimmed = args.title.trim();
  if (trimmed.length === 0) {
    throw new Error('Task title must not be empty');
  }
  const now = nowIso();
  const task: Task = {
    id: generateTaskId(),
    source: TaskSource.Manual,
    title: trimmed,
    projectRoot: ctx.projectRoot,
    worktreePath: null,
    branch: null,
    headSha: null,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: true,
    autopilotState: AutopilotState.Watching,
    lastAutopilotActivityAt: now,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
  await saveTask(ctx, task);
  if (args.description !== undefined && args.description.length > 0) {
    const paths = taskDirPaths(ctx.projectRoot, task.id);
    await ctx.fs.mkdir(paths.dir);
    await ctx.fs.writeFile(paths.description, args.description);
  }
  await appendEvent(ctx, {
    taskId: task.id,
    kind: EventKind.TaskCreated,
    payload: {
      title: task.title,
      source: task.source,
    },
    ts: now,
  });
  return {
    task,
  };
}

//#endregion
