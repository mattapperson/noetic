import { createHash } from 'node:crypto';

import { relations } from 'drizzle-orm';
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export type TaskReviewStatus = 'not_started' | 'reviewing' | 'needs_changes' | 'approved';
export type TaskLifecycleStatus = 'active' | 'merged' | 'cleanup-blocked' | 'removed';
export type TaskSource = 'git-worktree';
export type TaskSessionKind = 'agent_ci_review' | 'local_review' | 'manual';
export type TaskSessionStatus = 'active' | 'completed' | 'failed' | 'cancelled';

export function taskWorktreeId(projectRoot: string, worktreePath: string): string {
  return createHash('sha256').update(projectRoot).update('\0').update(worktreePath).digest('hex');
}

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectRoot: text('project_root').notNull(),
    worktreePath: text('worktree_path').notNull(),
    title: text('title').notNull(),
    branch: text('branch'),
    headSha: text('head_sha'),
    reviewStatus: text('review_status').notNull().$type<TaskReviewStatus>(),
    status: text('status').notNull().$type<TaskLifecycleStatus>().default('active'),
    source: text('source').notNull().$type<TaskSource>(),
    cleanupReason: text('cleanup_reason'),
    cleanupAt: text('cleanup_at'),
    provider: text('provider'),
    providerId: text('provider_id'),
    providerUrl: text('provider_url'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (table) => [
    uniqueIndex('tasks_worktree_path_uq').on(table.worktreePath),
    index('tasks_project_root_idx').on(table.projectRoot),
    index('tasks_status_idx').on(table.status),
    index('tasks_last_seen_idx').on(table.lastSeenAt),
  ],
);

export const taskSessions = sqliteTable(
  'task_sessions',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, {
        onDelete: 'cascade',
      }),
    sessionId: text('session_id').notNull(),
    kind: text('kind').notNull().$type<TaskSessionKind>(),
    status: text('status').notNull().$type<TaskSessionStatus>(),
    title: text('title'),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('task_sessions_task_id_idx').on(table.taskId),
    uniqueIndex('task_sessions_task_session_uq').on(table.taskId, table.sessionId),
  ],
);

export const tasksRelations = relations(tasks, ({ many }) => ({
  sessions: many(taskSessions),
}));

export const taskSessionsRelations = relations(taskSessions, ({ one }) => ({
  task: one(tasks, {
    fields: [
      taskSessions.taskId,
    ],
    references: [
      tasks.id,
    ],
  }),
}));

export type TaskRecord = typeof tasks.$inferSelect;
export type NewTaskRecord = typeof tasks.$inferInsert;
export type TaskSessionRecord = typeof taskSessions.$inferSelect;
export type NewTaskSessionRecord = typeof taskSessions.$inferInsert;
