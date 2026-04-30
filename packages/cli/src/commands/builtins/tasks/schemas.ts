import { randomBytes } from 'node:crypto';

import { z } from 'zod';

//#region Constants

/** Length of the random portion of generated IDs (matches plan's nanoid(10)). */
export const ID_LENGTH = 10;

/** Allowed prefixes for task-domain entities. */
export const IdPrefix = {
  Task: 'T',
  Milestone: 'ML',
  Slice: 'SL',
  Feature: 'F',
  Assertion: 'A',
  ValidatorRun: 'V',
  FixLineage: 'FX',
  InterviewSession: 'IV',
} as const;

export type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix];

/** Per-log-line cap; longer messages are split by `appendLog`. Sub-PIPE_BUF (4 KiB). */
export const LOG_LINE_MAX_BYTES = 3 * 1024;

/** Current on-disk schema version recorded in `_state.json`. */
export const SCHEMA_VERSION = 1;

//#endregion

//#region ID generation

const ID_REGEX = new RegExp(`^[A-Za-z]{1,3}-[A-Za-z0-9_-]{${ID_LENGTH}}$`);

/** Generate a prefixed ID like `T-aB3-xy_91Q`. */
export function generateId(prefix: IdPrefix): string {
  // 8 random bytes → 11 base64url chars; slice to ID_LENGTH (10) for compactness.
  const random = randomBytes(8).toString('base64url').slice(0, ID_LENGTH);
  return `${prefix}-${random}`;
}

export function generateTaskId(): string {
  return generateId(IdPrefix.Task);
}

export function isValidId(value: string): boolean {
  return ID_REGEX.test(value);
}

//#endregion

//#region Task schema

export const TaskReviewStatus = {
  NotStarted: 'not_started',
  Reviewing: 'reviewing',
  NeedsChanges: 'needs_changes',
  Approved: 'approved',
} as const;

export type TaskReviewStatus = (typeof TaskReviewStatus)[keyof typeof TaskReviewStatus];

export const TaskLifecycleStatus = {
  Active: 'active',
  Merged: 'merged',
  CleanupBlocked: 'cleanup-blocked',
  Removed: 'removed',
} as const;

export type TaskLifecycleStatus = (typeof TaskLifecycleStatus)[keyof typeof TaskLifecycleStatus];

export const TaskSource = {
  Manual: 'manual',
  Worktree: 'worktree',
} as const;

export type TaskSource = (typeof TaskSource)[keyof typeof TaskSource];

export const HierarchyStatus = {
  Planning: 'planning',
  Active: 'active',
  Blocked: 'blocked',
  Complete: 'complete',
  Archived: 'archived',
} as const;

export type HierarchyStatus = (typeof HierarchyStatus)[keyof typeof HierarchyStatus];

export const AutopilotState = {
  Inactive: 'inactive',
  Watching: 'watching',
  Activating: 'activating',
  Completing: 'completing',
} as const;

export type AutopilotState = (typeof AutopilotState)[keyof typeof AutopilotState];

export const TaskIdSchema = z
  .string()
  .regex(new RegExp(`^T-[A-Za-z0-9_-]{${ID_LENGTH}}$`), 'must be of the form T-<10 chars>');

export const TaskSchema = z.object({
  id: TaskIdSchema,
  source: z.enum([
    TaskSource.Manual,
    TaskSource.Worktree,
  ]),
  title: z.string().min(1),
  projectRoot: z.string().min(1),

  worktreePath: z.string().nullable(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),

  reviewStatus: z.enum([
    TaskReviewStatus.NotStarted,
    TaskReviewStatus.Reviewing,
    TaskReviewStatus.NeedsChanges,
    TaskReviewStatus.Approved,
  ]),
  lifecycleStatus: z.enum([
    TaskLifecycleStatus.Active,
    TaskLifecycleStatus.Merged,
    TaskLifecycleStatus.CleanupBlocked,
    TaskLifecycleStatus.Removed,
  ]),
  paused: z.boolean(),
  archivedAt: z.string().nullable(),

  hierarchyStatus: z
    .enum([
      HierarchyStatus.Planning,
      HierarchyStatus.Active,
      HierarchyStatus.Blocked,
      HierarchyStatus.Complete,
      HierarchyStatus.Archived,
    ])
    .nullable(),
  autopilotEnabled: z.boolean(),
  autopilotState: z.enum([
    AutopilotState.Inactive,
    AutopilotState.Watching,
    AutopilotState.Activating,
    AutopilotState.Completing,
  ]),
  lastAutopilotActivityAt: z.string().nullable(),

  createdAt: z.string(),
  updatedAt: z.string(),
  lastSeenAt: z.string(),
});

export type Task = z.infer<typeof TaskSchema>;

//#endregion

//#region Log + event schemas

export const LogEntryKind = {
  Log: 'log',
  Comment: 'comment',
  Steer: 'steer',
  System: 'system',
} as const;

export type LogEntryKind = (typeof LogEntryKind)[keyof typeof LogEntryKind];

export const LogEntrySchema = z.object({
  kind: z.enum([
    LogEntryKind.Log,
    LogEntryKind.Comment,
    LogEntryKind.Steer,
    LogEntryKind.System,
  ]),
  ts: z.string(),
  message: z.string(),
  /** Index of this chunk when a long message is split (1-based). 1 unless split. */
  chunk: z.number().int().positive().optional(),
  /** Total chunks the original message was split into. 1 unless split. */
  chunkCount: z.number().int().positive().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type LogEntry = z.infer<typeof LogEntrySchema>;

export const EventKind = {
  TaskCreated: 'task:created',
  TaskUpdated: 'task:updated',
  TaskMoved: 'task:moved',
  TaskArchived: 'task:archived',
  /**
   * Hard-delete (the on-disk task dir was removed). Distinct from
   * `TaskArchived` so listeners can drop the row instead of treating
   * it as recoverable.
   */
  TaskDeleted: 'task:deleted',
  TaskReviewStatusChanged: 'task:reviewStatusChanged',
  SessionFinished: 'session:finished',
  LogAppended: 'log:appended',
  MilestoneCreated: 'milestone:created',
  SliceCreated: 'slice:created',
  FeatureCreated: 'feature:created',
  AssertionCreated: 'assertion:created',
  FeatureLoopStateChanged: 'feature:loopStateChanged',
  FeatureLinkedToTask: 'feature:linkedToTask',
  FeatureFixGenerated: 'feature:fixGenerated',
  FeatureBudgetExhausted: 'feature:budgetExhausted',
  ValidatorRunRecorded: 'validator:runRecorded',
  HierarchyStatusChanged: 'mission:statusChanged',
} as const;

export type EventKind = (typeof EventKind)[keyof typeof EventKind];

export const EventSchema = z.object({
  id: z.number().int().nonnegative(),
  taskId: z.string().nullable(),
  kind: z.enum([
    EventKind.TaskCreated,
    EventKind.TaskUpdated,
    EventKind.TaskMoved,
    EventKind.TaskArchived,
    EventKind.TaskDeleted,
    EventKind.TaskReviewStatusChanged,
    EventKind.SessionFinished,
    EventKind.LogAppended,
    EventKind.MilestoneCreated,
    EventKind.SliceCreated,
    EventKind.FeatureCreated,
    EventKind.AssertionCreated,
    EventKind.FeatureLoopStateChanged,
    EventKind.FeatureLinkedToTask,
    EventKind.FeatureFixGenerated,
    EventKind.FeatureBudgetExhausted,
    EventKind.ValidatorRunRecorded,
    EventKind.HierarchyStatusChanged,
  ]),
  payload: z.record(z.string(), z.unknown()).optional(),
  ts: z.string(),
});

export type Event = z.infer<typeof EventSchema>;

//#endregion

//#region State schema

export const StateSchema = z.object({
  schemaVersion: z.number().int().positive(),
  lastEventId: z.number().int().nonnegative(),
});

export type State = z.infer<typeof StateSchema>;

//#endregion
