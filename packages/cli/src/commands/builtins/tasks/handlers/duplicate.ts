import { join } from 'node:path';

import { emitTaskEvent } from '../events.js';
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
    const text = await ctx.fs.readFileText(join(sourceDir, entry));
    await ctx.fs.writeFile(join(destDir, entry), text);
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
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: false,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
  await saveTask(ctx, newTask);

  const sourcePaths = taskDirPaths(ctx.projectRoot, source.id);
  const destPaths = taskDirPaths(ctx.projectRoot, newTask.id);
  await ctx.fs.mkdir(destPaths.dir);
  await copyOptionalFile(ctx, sourcePaths.description, destPaths.description);
  await copyAttachments(ctx, sourcePaths.attachments, destPaths.attachments);

  const event = await appendEvent(ctx, {
    taskId: newTask.id,
    kind: EventKind.TaskCreated,
    payload: {
      title: newTask.title,
      source: newTask.source,
      duplicatedFrom: source.id,
    },
    ts: now,
  });
  emitTaskEvent(event);
  return {
    task: newTask,
  };
}

//#endregion
