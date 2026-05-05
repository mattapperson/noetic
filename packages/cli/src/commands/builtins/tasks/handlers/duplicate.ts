import { join } from '@noetic/code-agent/tasks/path-utils';
import type { Task } from '@noetic/code-agent/tasks/schema';
import {
  AutopilotState,
  EventKind,
  generateTaskId,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { appendEvent, saveTask, taskDirPaths } from '@noetic/code-agent/tasks/store/fs-node';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

export interface DuplicateTaskArgs {
  readonly taskId: string;
  /** Optional title override; defaults to `<original> (copy)`. */
  readonly title?: string;
}

export interface DuplicateTaskResult {
  readonly task: Task;
}

//#endregion

//#region Helpers

async function copyOptionalFile(
  ctx: TaskStoreContext,
  source: string,
  destination: string,
): Promise<void> {
  let text: string;
  try {
    text = await ctx.fs.readFileText(source);
  } catch {
    return;
  }
  await ctx.fs.writeFile(destination, text);
}

async function copyAttachments(
  ctx: TaskStoreContext,
  sourceDir: string,
  destDir: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await ctx.fs.readdir(sourceDir);
  } catch {
    return;
  }
  if (entries.length === 0) {
    return;
  }
  await ctx.fs.mkdir(destDir);
  for (const entry of entries) {
    const bytes = await ctx.fs.readFile(join(sourceDir, entry));
    await ctx.fs.writeFileBytes(join(destDir, entry), bytes);
  }
}

//#endregion

//#region Public API

/**
 * Copy a task into a new id, preserving description and attachments
 * but resetting lifecycle (review status, archive timestamp,
 * autopilot). Hierarchies are NOT copied — duplicate is for branching
 * a starting point, not for cloning in-flight planning.
 */
export async function duplicateTaskHandler(
  ctx: TaskStoreContext,
  args: DuplicateTaskArgs,
): Promise<DuplicateTaskResult> {
  const source = await resolveTask(ctx, args.taskId);
  const now = nowIso();
  const newTask: Task = {
    id: generateTaskId(),
    source: TaskSource.Manual,
    title: args.title ?? `${source.title} (copy)`,
    projectRoot: source.projectRoot,
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
  await saveTask(ctx, newTask);

  const sourcePaths = taskDirPaths(ctx, source.id);
  const destPaths = taskDirPaths(ctx, newTask.id);
  await ctx.fs.mkdir(destPaths.dir);
  await copyOptionalFile(ctx, sourcePaths.description, destPaths.description);
  await copyAttachments(ctx, sourcePaths.attachments, destPaths.attachments);

  await appendEvent(ctx, {
    taskId: newTask.id,
    kind: EventKind.TaskCreated,
    payload: {
      title: newTask.title,
      source: newTask.source,
      duplicatedFrom: source.id,
    },
    ts: now,
  });
  return {
    task: newTask,
  };
}

//#endregion
