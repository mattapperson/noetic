import { createHash } from 'node:crypto';

import { relations } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export type TaskReviewStatus = 'not_started' | 'reviewing' | 'needs_changes' | 'approved';
export type TaskLifecycleStatus = 'active' | 'merged' | 'cleanup-blocked' | 'removed';
export type TaskSource = 'git-worktree';
export type TaskSessionKind = 'agent_ci_review' | 'local_review' | 'manual';
export type TaskSessionStatus = 'active' | 'completed' | 'failed' | 'cancelled';

export type MissionStatus = 'planning' | 'active' | 'blocked' | 'complete' | 'archived';
export type MilestoneStatus = 'pending' | 'active' | 'complete' | 'blocked';
export type SliceStatus = 'pending' | 'active' | 'complete' | 'blocked';
export type FeatureStatus = 'defined' | 'triaged' | 'done' | 'blocked';
export type FeatureLoopState =
  | 'idle'
  | 'implementing'
  | 'validating'
  | 'passed'
  | 'needs_fix'
  | 'blocked';
export type AutopilotState = 'inactive' | 'watching' | 'activating' | 'completing';
export type ValidatorRunStatus = 'pending' | 'running' | 'pass' | 'fail' | 'blocked' | 'error';
export type MissionContractAssertionStatus = 'pending' | 'passed' | 'failed' | 'blocked';

export const DEFAULT_IMPLEMENTATION_RETRY_BUDGET = 3;

export const AGENT_CI_REVIEW_KIND: TaskSessionKind = 'agent_ci_review';

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
    missionId: text('mission_id'),
    sliceId: text('slice_id'),
    featureId: text('feature_id'),
  },
  (table) => [
    uniqueIndex('tasks_worktree_path_uq').on(table.worktreePath),
    index('tasks_project_root_idx').on(table.projectRoot),
    index('tasks_status_idx').on(table.status),
    index('tasks_last_seen_idx').on(table.lastSeenAt),
    index('tasks_mission_id_idx').on(table.missionId),
    index('tasks_feature_id_idx').on(table.featureId),
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
    pid: integer('pid'),
    pausedAt: text('paused_at'),
    pidStarttime: text('pid_starttime'),
  },
  (table) => [
    index('task_sessions_task_id_idx').on(table.taskId),
    uniqueIndex('task_sessions_task_session_uq').on(table.taskId, table.sessionId),
  ],
);

export const missions = sqliteTable(
  'missions',
  {
    id: text('id').primaryKey(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().$type<MissionStatus>().default('planning'),
    interviewState: text('interview_state'),
    autopilotEnabled: integer('autopilot_enabled', {
      mode: 'boolean',
    })
      .notNull()
      .default(false),
    autopilotState: text('autopilot_state').notNull().$type<AutopilotState>().default('inactive'),
    lastAutopilotActivityAt: text('last_autopilot_activity_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('missions_status_idx').on(table.status),
  ],
);

export const milestones = sqliteTable(
  'milestones',
  {
    id: text('id').primaryKey(),
    missionId: text('mission_id')
      .notNull()
      .references(() => missions.id, {
        onDelete: 'cascade',
      }),
    title: text('title').notNull(),
    description: text('description'),
    verification: text('verification').notNull(),
    status: text('status').notNull().$type<MilestoneStatus>().default('pending'),
    orderIndex: integer('order_index').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('milestones_mission_order_idx').on(table.missionId, table.orderIndex),
  ],
);

export const slices = sqliteTable(
  'slices',
  {
    id: text('id').primaryKey(),
    milestoneId: text('milestone_id')
      .notNull()
      .references(() => milestones.id, {
        onDelete: 'cascade',
      }),
    title: text('title').notNull(),
    description: text('description'),
    verification: text('verification').notNull(),
    status: text('status').notNull().$type<SliceStatus>().default('pending'),
    orderIndex: integer('order_index').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('slices_milestone_order_idx').on(table.milestoneId, table.orderIndex),
  ],
);

export const missionFeatures = sqliteTable(
  'mission_features',
  {
    id: text('id').primaryKey(),
    sliceId: text('slice_id')
      .notNull()
      .references(() => slices.id, {
        onDelete: 'cascade',
      }),
    title: text('title').notNull(),
    description: text('description'),
    acceptanceCriteria: text('acceptance_criteria').notNull(),
    status: text('status').notNull().$type<FeatureStatus>().default('defined'),
    loopState: text('loop_state').notNull().$type<FeatureLoopState>().default('idle'),
    implementationAttemptCount: integer('implementation_attempt_count').notNull().default(0),
    validatorAttemptCount: integer('validator_attempt_count').notNull().default(0),
    taskId: text('task_id'),
    generatedFromFeatureId: text('generated_from_feature_id'),
    generatedFromRunId: text('generated_from_run_id'),
    blockedReason: text('blocked_reason'),
    orderIndex: integer('order_index').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('mission_features_slice_id_idx').on(table.sliceId),
    index('mission_features_task_id_idx').on(table.taskId),
    index('mission_features_loop_state_idx').on(table.loopState),
  ],
);

export const missionContractAssertions = sqliteTable(
  'mission_contract_assertions',
  {
    id: text('id').primaryKey(),
    milestoneId: text('milestone_id')
      .notNull()
      .references(() => milestones.id, {
        onDelete: 'cascade',
      }),
    title: text('title').notNull(),
    assertion: text('assertion').notNull(),
    status: text('status').notNull().$type<MissionContractAssertionStatus>().default('pending'),
    orderIndex: integer('order_index').notNull(),
    featureIds: text('feature_ids').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    index('mission_contract_assertions_milestone_idx').on(table.milestoneId),
  ],
);

export const missionValidatorRuns = sqliteTable(
  'mission_validator_runs',
  {
    id: text('id').primaryKey(),
    featureId: text('feature_id')
      .notNull()
      .references(() => missionFeatures.id, {
        onDelete: 'cascade',
      }),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
    status: text('status').notNull().$type<ValidatorRunStatus>().default('pending'),
    resultJson: text('result_json'),
    pid: integer('pid'),
    pidStarttime: text('pid_starttime'),
    pausedAt: text('paused_at'),
  },
  (table) => [
    index('mission_validator_runs_feature_started_idx').on(table.featureId, table.startedAt),
  ],
);

export const missionFixFeatureLineage = sqliteTable(
  'mission_fix_feature_lineage',
  {
    id: text('id').primaryKey(),
    sourceFeatureId: text('source_feature_id')
      .notNull()
      .references(() => missionFeatures.id, {
        onDelete: 'cascade',
      }),
    fixFeatureId: text('fix_feature_id')
      .notNull()
      .references(() => missionFeatures.id, {
        onDelete: 'cascade',
      }),
    validatorRunId: text('validator_run_id')
      .notNull()
      .references(() => missionValidatorRuns.id, {
        onDelete: 'cascade',
      }),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('mission_fix_feature_lineage_uq').on(table.sourceFeatureId, table.fixFeatureId),
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

export const missionsRelations = relations(missions, ({ many }) => ({
  milestones: many(milestones),
}));

export const milestonesRelations = relations(milestones, ({ one, many }) => ({
  mission: one(missions, {
    fields: [
      milestones.missionId,
    ],
    references: [
      missions.id,
    ],
  }),
  slices: many(slices),
  assertions: many(missionContractAssertions),
}));

export const slicesRelations = relations(slices, ({ one, many }) => ({
  milestone: one(milestones, {
    fields: [
      slices.milestoneId,
    ],
    references: [
      milestones.id,
    ],
  }),
  features: many(missionFeatures),
}));

export const missionFeaturesRelations = relations(missionFeatures, ({ one, many }) => ({
  slice: one(slices, {
    fields: [
      missionFeatures.sliceId,
    ],
    references: [
      slices.id,
    ],
  }),
  validatorRuns: many(missionValidatorRuns),
}));

export const missionContractAssertionsRelations = relations(
  missionContractAssertions,
  ({ one }) => ({
    milestone: one(milestones, {
      fields: [
        missionContractAssertions.milestoneId,
      ],
      references: [
        milestones.id,
      ],
    }),
  }),
);

export const missionValidatorRunsRelations = relations(missionValidatorRuns, ({ one }) => ({
  feature: one(missionFeatures, {
    fields: [
      missionValidatorRuns.featureId,
    ],
    references: [
      missionFeatures.id,
    ],
  }),
}));

export const missionFixFeatureLineageRelations = relations(missionFixFeatureLineage, ({ one }) => ({
  sourceFeature: one(missionFeatures, {
    fields: [
      missionFixFeatureLineage.sourceFeatureId,
    ],
    references: [
      missionFeatures.id,
    ],
    relationName: 'mission_fix_lineage_source',
  }),
  fixFeature: one(missionFeatures, {
    fields: [
      missionFixFeatureLineage.fixFeatureId,
    ],
    references: [
      missionFeatures.id,
    ],
    relationName: 'mission_fix_lineage_fix',
  }),
  validatorRun: one(missionValidatorRuns, {
    fields: [
      missionFixFeatureLineage.validatorRunId,
    ],
    references: [
      missionValidatorRuns.id,
    ],
  }),
}));

export type TaskRecord = typeof tasks.$inferSelect;
export type NewTaskRecord = typeof tasks.$inferInsert;
export type TaskSessionRecord = typeof taskSessions.$inferSelect;
export type NewTaskSessionRecord = typeof taskSessions.$inferInsert;

export type MissionRecord = typeof missions.$inferSelect;
export type NewMissionRecord = typeof missions.$inferInsert;
export type MilestoneRecord = typeof milestones.$inferSelect;
export type NewMilestoneRecord = typeof milestones.$inferInsert;
export type SliceRecord = typeof slices.$inferSelect;
export type NewSliceRecord = typeof slices.$inferInsert;
export type MissionFeatureRecord = typeof missionFeatures.$inferSelect;
export type NewMissionFeatureRecord = typeof missionFeatures.$inferInsert;
export type MissionContractAssertionRecord = typeof missionContractAssertions.$inferSelect;
export type NewMissionContractAssertionRecord = typeof missionContractAssertions.$inferInsert;
export type MissionValidatorRunRecord = typeof missionValidatorRuns.$inferSelect;
export type NewMissionValidatorRunRecord = typeof missionValidatorRuns.$inferInsert;
export type MissionFixFeatureLineageRecord = typeof missionFixFeatureLineage.$inferSelect;
export type NewMissionFixFeatureLineageRecord = typeof missionFixFeatureLineage.$inferInsert;
