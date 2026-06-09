/**
 * Task lifecycle handlers: create, delete, duplicate, archive, unarchive.
 */

import { listLiveTaskHandles, TaskRole } from '@noetic-tools/code-agent/tasks';
import { join } from '@noetic-tools/code-agent/tasks/path-utils';
import type { Task } from '@noetic-tools/code-agent/tasks/schema';
import {
  AutopilotState,
  EventKind,
  generateTaskId,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic-tools/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic-tools/code-agent/tasks/store/fs-node';
import {
  appendEvent,
  deleteTaskDir,
  saveTask,
  taskDirPaths,
} from '@noetic-tools/code-agent/tasks/store/fs-node';
import type { SubprocessAdapter, SubprocessHandle } from '@noetic-tools/core';
import type { Signaller } from '../agent-ci-control.js';
import { defaultSignaller, verifyPidIdentity } from '../agent-ci-control.js';
import { getTaskHierarchy } from '../hierarchy/aggregate.js';
import { ValidatorRunStatus } from '../hierarchy/schemas.js';
import { listValidatorRuns } from '../hierarchy/validator.js';
import { loadRunner } from '../runner-state.js';
import { nowIso, resolveTask } from './_shared.js';

//#region create

export interface CreateTaskArgs {
  readonly title: string;
  readonly description?: string;
}

export interface CreateTaskResult {
  readonly task: Task;
}

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
    const paths = taskDirPaths(ctx, task.id);
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

//#region delete

export interface DeleteTaskArgs {
  readonly taskId: string;
  /**
   * Subprocess adapter whose live-handle manifest is queried to detect
   * attached planner/implementer runners. Required — pass the shared
   * host adapter so the listLive scan sees every runner the TUI/daemon
   * has spawned.
   */
  readonly subprocess: SubprocessAdapter;
  /**
   * Override the live-runner / running-validator guards. Without this,
   * deletion is refused while any subprocess is still attached to the
   * task directory.
   */
  readonly force?: boolean;
  /**
   * Test seam: override the default signaller used for live-pid checks
   * on the agent-ci runner sidecar. Defaults to `defaultSignaller`.
   */
  readonly signaller?: Signaller;
}

export interface DeleteTaskResult {
  readonly taskId: string;
}

/**
 * Discriminator for the kind of subprocess blocking a delete.
 * Surfaced in the error message so the user knows which subsystem is
 * still attached.
 */
export const SidecarKind = {
  AgentCi: 'agent-ci',
  Implementer: 'implementer',
  Planner: 'planner',
} as const;

export type SidecarKind = (typeof SidecarKind)[keyof typeof SidecarKind];

export interface LiveSidecar {
  readonly kind: SidecarKind;
  readonly pid: number;
  readonly sessionId: string;
}

/**
 * Look for any `running` validator run under the task's hierarchy.
 * Returns the first hit's run id, or null if all runs are terminal.
 */
async function findActiveValidatorRunId(
  ctx: TaskStoreContext,
  taskId: string,
): Promise<string | null> {
  const hierarchy = await getTaskHierarchy(ctx, taskId);
  if (hierarchy === null) {
    return null;
  }
  for (const milestone of hierarchy.milestones) {
    for (const slice of milestone.slices) {
      for (const feature of slice.features) {
        const runs = await listValidatorRuns(
          {
            ...ctx,
            taskId,
          },
          feature.id,
        );
        for (const run of runs) {
          if (run.status === ValidatorRunStatus.Running && run.completedAt === null) {
            return run.id;
          }
        }
      }
    }
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readMetaNumber(handle: SubprocessHandle, key: string): number | null {
  const meta = handle.metadata;
  if (!isRecord(meta)) {
    return null;
  }
  const value = meta[key];
  return typeof value === 'number' ? value : null;
}

function readMetaString(handle: SubprocessHandle, key: string): string | null {
  const meta = handle.metadata;
  if (!isRecord(meta)) {
    return null;
  }
  const value = meta[key];
  return typeof value === 'string' ? value : null;
}

function sidecarKindForRole(role: string): SidecarKind | null {
  if (role === TaskRole.Planner) {
    return SidecarKind.Planner;
  }
  if (role === TaskRole.Implementer) {
    return SidecarKind.Implementer;
  }
  return null;
}

export interface FindLiveSidecarsArgs {
  readonly ctx: TaskStoreContext;
  readonly taskId: string;
  readonly subprocess: SubprocessAdapter;
  readonly signaller?: Signaller;
}

/**
 * Returns one entry per live subprocess attached to the task, so the
 * caller can name the blocking subsystem in the error message. Stale
 * agent-ci sidecars (dead pid, recycled pid, `ps` failure) are filtered
 * out via {@link verifyPidIdentity}; planner/implementer handles come
 * from the subprocess adapter's `listLive()` manifest which already
 * performs pidStarttime drift detection.
 */
export async function findLiveSidecars(
  args: FindLiveSidecarsArgs,
): Promise<ReadonlyArray<LiveSidecar>> {
  const signaller = args.signaller ?? defaultSignaller;
  const [runner, taskHandles] = await Promise.all([
    loadRunner(args.ctx, args.taskId),
    listLiveTaskHandles(args.subprocess, args.taskId),
  ]);
  const out: LiveSidecar[] = [];
  if (runner !== null && verifyPidIdentity(signaller, runner.pid, runner.pidStarttime)) {
    out.push({
      kind: SidecarKind.AgentCi,
      pid: runner.pid,
      sessionId: runner.sessionId,
    });
  }
  for (const handle of taskHandles) {
    const role = readMetaString(handle, 'taskRole');
    if (role === null) {
      continue;
    }
    const kind = sidecarKindForRole(role);
    if (kind === null) {
      continue;
    }
    const pid = readMetaNumber(handle, 'pid');
    if (pid === null) {
      continue;
    }
    out.push({
      kind,
      pid,
      sessionId: handle.id,
    });
  }
  return out;
}

/**
 * Hard-delete a task. Emits `task:deleted` so listeners that mirror
 * state to other surfaces (UI lists, search indexes) can drop the
 * task's row, then removes the on-disk directory.
 *
 * Refuses to delete if a live agent-ci, implementer, or planner
 * subprocess is attached, or any feature under the task has a `running`
 * validator run — the subprocess could be writing into the task dir
 * mid-delete. Pass `force: true` to override.
 */
export async function deleteTaskHandler(
  ctx: TaskStoreContext,
  args: DeleteTaskArgs,
): Promise<DeleteTaskResult> {
  const existing = await resolveTask(ctx, args.taskId);
  if (args.force !== true) {
    const liveSidecars = await findLiveSidecars({
      ctx,
      taskId: existing.id,
      subprocess: args.subprocess,
      signaller: args.signaller,
    });
    if (liveSidecars.length > 0) {
      const summary = liveSidecars.map((sc) => `${sc.kind} runner pid=${sc.pid}`).join(', ');
      throw new Error(
        `Refusing to delete ${existing.id}: ${summary} still attached. Pass --force to override.`,
      );
    }
    const activeRunId = await findActiveValidatorRunId(ctx, existing.id);
    if (activeRunId !== null) {
      throw new Error(
        `Refusing to delete ${existing.id}: validator run ${activeRunId} is still running. Pass --force to override.`,
      );
    }
  }
  const ts = nowIso();
  await appendEvent(ctx, {
    taskId: existing.id,
    kind: EventKind.TaskDeleted,
    payload: {
      reason: 'deleted',
    },
    ts,
  });
  await deleteTaskDir(ctx, existing.id);
  return {
    taskId: existing.id,
  };
}

//#endregion

//#region duplicate

export interface DuplicateTaskArgs {
  readonly taskId: string;
  /** Optional title override; defaults to `<original> (copy)`. */
  readonly title?: string;
}

export interface DuplicateTaskResult {
  readonly task: Task;
}

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

//#region archive

export interface ArchiveTaskArgs {
  readonly taskId: string;
}

export interface ArchiveTaskResult {
  readonly task: Task;
}

/**
 * Mark a task archived by stamping `archivedAt`. Idempotent: if the
 * task is already archived, the existing timestamp is preserved.
 */
export async function archiveTaskHandler(
  ctx: TaskStoreContext,
  args: ArchiveTaskArgs,
): Promise<ArchiveTaskResult> {
  const existing = await resolveTask(ctx, args.taskId);
  const ts = nowIso();
  const next: Task = {
    ...existing,
    archivedAt: existing.archivedAt ?? ts,
    updatedAt: ts,
  };
  await saveTask(ctx, next);
  await appendEvent(ctx, {
    taskId: next.id,
    kind: EventKind.TaskArchived,
    payload: {
      archivedAt: next.archivedAt,
    },
    ts,
  });
  return {
    task: next,
  };
}

//#endregion

//#region unarchive

export interface UnarchiveTaskArgs {
  readonly taskId: string;
}

export interface UnarchiveTaskResult {
  readonly task: Task;
}

/** Clear `archivedAt`, returning the task to its prior column. */
export async function unarchiveTaskHandler(
  ctx: TaskStoreContext,
  args: UnarchiveTaskArgs,
): Promise<UnarchiveTaskResult> {
  const existing = await resolveTask(ctx, args.taskId);
  const ts = nowIso();
  const next: Task = {
    ...existing,
    archivedAt: null,
    updatedAt: ts,
  };
  await saveTask(ctx, next);
  await appendEvent(ctx, {
    taskId: next.id,
    kind: EventKind.TaskArchived,
    payload: {
      archivedAt: null,
    },
    ts,
  });
  return {
    task: next,
  };
}

//#endregion
