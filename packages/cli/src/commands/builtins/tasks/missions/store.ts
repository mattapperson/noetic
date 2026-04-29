import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { z } from 'zod';

import type { TasksDatabase } from '../db/index.js';
import { openTasksDatabase } from '../db/index.js';
import type * as schema from '../db/schema.js';
import type {
  FeatureLoopState,
  MilestoneRecord,
  MissionContractAssertionRecord,
  MissionFeatureRecord,
  MissionFixFeatureLineageRecord,
  MissionRecord,
  MissionStatus,
  MissionValidatorRunRecord,
  SliceRecord,
  TaskRecord,
  ValidatorRunStatus,
} from '../db/schema.js';
import {
  DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
  milestones,
  missionContractAssertions,
  missionFeatures,
  missionFixFeatureLineage,
  missions,
  missionValidatorRuns,
  slices,
  tasks,
} from '../db/schema.js';

type TasksDb = BunSQLiteDatabase<typeof schema>;
type DbTransaction = Parameters<Parameters<TasksDb['transaction']>[0]>[0];

//#region Events

export const missionEvents = new EventEmitter();

export const MissionEventName = {
  MissionCreated: 'mission.created',
  MissionStatusChanged: 'mission.statusChanged',
  FeatureLoopStateChanged: 'feature.loopStateChanged',
  FeatureLinkedToTask: 'feature.linkedToTask',
  ValidatorRunRecorded: 'validator.runRecorded',
  FeatureFixGenerated: 'feature.fixGenerated',
  FeatureBudgetExhausted: 'feature.budgetExhausted',
} as const;

export type MissionEventNameValue = (typeof MissionEventName)[keyof typeof MissionEventName];

//#endregion

//#region Errors

export class BudgetExhaustedError extends Error {
  readonly featureId: string;
  readonly attemptCount: number;
  readonly budget: number;

  constructor(featureId: string, attemptCount: number, budget: number) {
    super(
      `Implementation retry budget exhausted for feature ${featureId} (${attemptCount}/${budget}).`,
    );
    this.name = 'BudgetExhaustedError';
    this.featureId = featureId;
    this.attemptCount = attemptCount;
    this.budget = budget;
  }
}

//#endregion

//#region Inputs and aggregate types

const AcceptanceCriteriaSchema = z.array(z.string());
const FeatureIdsSchema = z.array(z.string());

export interface MissionFeatureInput {
  title: string;
  description?: string;
  acceptanceCriteria: string[];
}

export interface MissionAssertionInput {
  title: string;
  assertion: string;
  featureIds: string[];
}

export interface MissionSliceInput {
  title: string;
  description?: string;
  verification: string;
  features: MissionFeatureInput[];
}

export interface MissionMilestoneInput {
  title: string;
  description?: string;
  verification: string;
  slices: MissionSliceInput[];
  assertions?: MissionAssertionInput[];
}

export interface MissionTreeInput {
  title: string;
  description?: string;
  milestones: MissionMilestoneInput[];
}

export interface MissionHierarchyAssertion extends MissionContractAssertionRecord {
  featureIdsParsed: string[];
}

export interface MissionHierarchyFeature extends MissionFeatureRecord {
  acceptanceCriteriaParsed: string[];
}

export interface MissionHierarchySlice extends SliceRecord {
  features: MissionHierarchyFeature[];
}

export interface MissionHierarchyMilestone extends MilestoneRecord {
  slices: MissionHierarchySlice[];
  assertions: MissionHierarchyAssertion[];
}

export interface MissionHierarchy {
  mission: MissionRecord;
  milestones: MissionHierarchyMilestone[];
}

export interface FeatureLoopSnapshot {
  feature: MissionFeatureRecord;
  runs: MissionValidatorRunRecord[];
  lineage: MissionFixFeatureLineageRecord[];
  retryBudgetRemaining: number;
}

//#endregion

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

export type OpenMissionsDatabase = (cwd: string) => TasksDatabase;

let openDatabaseImpl: OpenMissionsDatabase = openTasksDatabase;

/** Test seam: override the database opener so tests can hit a per-test sqlite path. */
export function setOpenMissionsDatabase(fn: OpenMissionsDatabase): void {
  openDatabaseImpl = fn;
}

/** Test seam: restore the default database opener. */
export function resetOpenMissionsDatabase(): void {
  openDatabaseImpl = openTasksDatabase;
}

function withDb<R>(cwd: string, fn: (opened: TasksDatabase) => R): R {
  const opened = openDatabaseImpl(cwd);
  try {
    return fn(opened);
  } finally {
    opened.close();
  }
}

function parseAcceptanceCriteria(raw: string): string[] {
  return AcceptanceCriteriaSchema.parse(JSON.parse(raw));
}

function parseFeatureIds(raw: string): string[] {
  return FeatureIdsSchema.parse(JSON.parse(raw));
}

function emit(event: MissionEventNameValue, payload: Record<string, unknown>): void {
  missionEvents.emit(event, payload);
}

function getMissionRow(db: TasksDb, id: string): MissionRecord | null {
  return db.select().from(missions).where(eq(missions.id, id)).get() ?? null;
}

function getFeatureRow(db: TasksDb, id: string): MissionFeatureRecord | null {
  return db.select().from(missionFeatures).where(eq(missionFeatures.id, id)).get() ?? null;
}

function requireFeature(db: TasksDb, id: string): MissionFeatureRecord {
  const row = getFeatureRow(db, id);
  if (row === null) {
    throw new Error(`Feature ${id} not found.`);
  }
  return row;
}

function requireMission(db: TasksDb, id: string): MissionRecord {
  const row = getMissionRow(db, id);
  if (row === null) {
    throw new Error(`Mission ${id} not found.`);
  }
  return row;
}

function getSliceRow(db: TasksDb, id: string): SliceRecord | null {
  return db.select().from(slices).where(eq(slices.id, id)).get() ?? null;
}

function requireSlice(db: TasksDb, id: string): SliceRecord {
  const row = getSliceRow(db, id);
  if (row === null) {
    throw new Error(`Slice ${id} not found.`);
  }
  return row;
}

function findMissionIdForSlice(db: TasksDb, sliceId: string): string {
  const slice = requireSlice(db, sliceId);
  const milestone = db.select().from(milestones).where(eq(milestones.id, slice.milestoneId)).get();
  if (!milestone) {
    throw new Error(`Milestone ${slice.milestoneId} not found for slice ${sliceId}.`);
  }
  return milestone.missionId;
}

function findMissionIdForFeature(db: TasksDb, featureId: string): string {
  const feature = requireFeature(db, featureId);
  return findMissionIdForSlice(db, feature.sliceId);
}

interface ApplyFeatureLoopStateUpdateArgs {
  tx: DbTransaction;
  featureId: string;
  newState: FeatureLoopState;
  patch?: Partial<typeof missionFeatures.$inferInsert>;
}

function applyFeatureLoopStateUpdate(args: ApplyFeatureLoopStateUpdateArgs): MissionFeatureRecord {
  const { tx, featureId, newState, patch = {} } = args;
  const now = nowIso();
  tx.update(missionFeatures)
    .set({
      ...patch,
      loopState: newState,
      updatedAt: now,
    })
    .where(eq(missionFeatures.id, featureId))
    .run();
  const updated = tx.select().from(missionFeatures).where(eq(missionFeatures.id, featureId)).get();
  if (!updated) {
    throw new Error(`Feature ${featureId} disappeared mid-transaction.`);
  }
  return updated;
}

//#endregion

//#region Mission CRUD

export function createMission(
  cwd: string,
  args: {
    title: string;
    description?: string;
  },
): MissionRecord {
  const id = randomUUID();
  const now = nowIso();
  const row = withDb(cwd, ({ db }) => {
    db.insert(missions)
      .values({
        id,
        title: args.title,
        description: args.description ?? null,
        status: 'planning',
        autopilotEnabled: false,
        autopilotState: 'inactive',
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return requireMission(db, id);
  });
  emit(MissionEventName.MissionCreated, {
    missionId: row.id,
    mission: row,
  });
  return row;
}

export function getMission(cwd: string, id: string): MissionRecord | null {
  return withDb(cwd, ({ db }) => getMissionRow(db, id));
}

export function getMissionWithHierarchy(cwd: string, id: string): MissionHierarchy | null {
  return withDb(cwd, ({ db }) => {
    const mission = getMissionRow(db, id);
    if (mission === null) {
      return null;
    }
    const milestoneRows = db
      .select()
      .from(milestones)
      .where(eq(milestones.missionId, id))
      .orderBy(asc(milestones.orderIndex))
      .all();

    const hierarchy: MissionHierarchyMilestone[] = milestoneRows.map((milestone) => {
      const sliceRows = db
        .select()
        .from(slices)
        .where(eq(slices.milestoneId, milestone.id))
        .orderBy(asc(slices.orderIndex))
        .all();
      const sliceIds = sliceRows.map((slice) => slice.id);
      const featureRows =
        sliceIds.length > 0
          ? db
              .select()
              .from(missionFeatures)
              .where(inArray(missionFeatures.sliceId, sliceIds))
              .orderBy(asc(missionFeatures.orderIndex))
              .all()
          : [];
      const assertionRows = db
        .select()
        .from(missionContractAssertions)
        .where(eq(missionContractAssertions.milestoneId, milestone.id))
        .orderBy(asc(missionContractAssertions.orderIndex))
        .all();
      const sliceHierarchy: MissionHierarchySlice[] = sliceRows.map((slice) => ({
        ...slice,
        features: featureRows
          .filter((feature) => feature.sliceId === slice.id)
          .map((feature) => ({
            ...feature,
            acceptanceCriteriaParsed: parseAcceptanceCriteria(feature.acceptanceCriteria),
          })),
      }));
      const assertions: MissionHierarchyAssertion[] = assertionRows.map((row) => ({
        ...row,
        featureIdsParsed: parseFeatureIds(row.featureIds),
      }));
      return {
        ...milestone,
        slices: sliceHierarchy,
        assertions,
      };
    });

    return {
      mission,
      milestones: hierarchy,
    };
  });
}

export function updateMission(
  cwd: string,
  id: string,
  patch: Partial<MissionRecord>,
): MissionRecord {
  const now = nowIso();
  const result = withDb(cwd, ({ db }) => {
    const existing = requireMission(db, id);
    const next: Partial<typeof missions.$inferInsert> = {
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
    };
    db.update(missions).set(next).where(eq(missions.id, id)).run();
    const updated = requireMission(db, id);
    return {
      previous: existing,
      updated,
    };
  });
  if (result.previous.status !== result.updated.status) {
    emit(MissionEventName.MissionStatusChanged, {
      missionId: id,
      previousStatus: result.previous.status,
      status: result.updated.status,
    });
  }
  return result.updated;
}

export function listMissions(
  cwd: string,
  filter: {
    status?: MissionStatus[];
  } = {},
): MissionRecord[] {
  return withDb(cwd, ({ db }) => {
    const baseQuery = db.select().from(missions);
    const filtered =
      filter.status && filter.status.length > 0
        ? baseQuery.where(inArray(missions.status, filter.status))
        : baseQuery;
    return filtered.orderBy(desc(missions.createdAt)).all();
  });
}

export function deleteMission(cwd: string, id: string): void {
  withDb(cwd, ({ db }) => {
    db.delete(missions).where(eq(missions.id, id)).run();
  });
}

//#endregion

//#region Hierarchy mutation

export function addMilestone(
  cwd: string,
  args: {
    missionId: string;
    title: string;
    description?: string;
    verification: string;
    orderIndex: number;
  },
): MilestoneRecord {
  const id = randomUUID();
  const now = nowIso();
  return withDb(cwd, ({ db }) => {
    requireMission(db, args.missionId);
    db.insert(milestones)
      .values({
        id,
        missionId: args.missionId,
        title: args.title,
        description: args.description ?? null,
        verification: args.verification,
        status: 'pending',
        orderIndex: args.orderIndex,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const row = db.select().from(milestones).where(eq(milestones.id, id)).get();
    if (!row) {
      throw new Error(`Milestone ${id} not inserted.`);
    }
    return row;
  });
}

export function addSlice(
  cwd: string,
  args: {
    milestoneId: string;
    title: string;
    description?: string;
    verification: string;
    orderIndex: number;
  },
): SliceRecord {
  const id = randomUUID();
  const now = nowIso();
  return withDb(cwd, ({ db }) => {
    db.insert(slices)
      .values({
        id,
        milestoneId: args.milestoneId,
        title: args.title,
        description: args.description ?? null,
        verification: args.verification,
        status: 'pending',
        orderIndex: args.orderIndex,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const row = db.select().from(slices).where(eq(slices.id, id)).get();
    if (!row) {
      throw new Error(`Slice ${id} not inserted.`);
    }
    return row;
  });
}

export function addFeature(
  cwd: string,
  args: {
    sliceId: string;
    title: string;
    description?: string;
    acceptanceCriteria: string[];
    orderIndex: number;
  },
): MissionFeatureRecord {
  const id = randomUUID();
  const now = nowIso();
  return withDb(cwd, ({ db }) => {
    db.insert(missionFeatures)
      .values({
        id,
        sliceId: args.sliceId,
        title: args.title,
        description: args.description ?? null,
        acceptanceCriteria: JSON.stringify(args.acceptanceCriteria),
        status: 'defined',
        loopState: 'idle',
        implementationAttemptCount: 0,
        validatorAttemptCount: 0,
        taskId: null,
        generatedFromFeatureId: null,
        generatedFromRunId: null,
        blockedReason: null,
        orderIndex: args.orderIndex,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return requireFeature(db, id);
  });
}

export function addAssertion(
  cwd: string,
  args: {
    milestoneId: string;
    title: string;
    assertion: string;
    orderIndex: number;
    featureIds: string[];
  },
): MissionContractAssertionRecord {
  const id = randomUUID();
  const now = nowIso();
  return withDb(cwd, ({ db }) => {
    db.insert(missionContractAssertions)
      .values({
        id,
        milestoneId: args.milestoneId,
        title: args.title,
        assertion: args.assertion,
        status: 'pending',
        orderIndex: args.orderIndex,
        featureIds: JSON.stringify(args.featureIds),
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const row = db
      .select()
      .from(missionContractAssertions)
      .where(eq(missionContractAssertions.id, id))
      .get();
    if (!row) {
      throw new Error(`Assertion ${id} not inserted.`);
    }
    return row;
  });
}

export function persistMissionTree(cwd: string, tree: MissionTreeInput): MissionRecord {
  const now = nowIso();
  const missionId = randomUUID();
  const inserted = withDb(cwd, ({ db }) =>
    db.transaction((tx): MissionRecord => {
      tx.insert(missions)
        .values({
          id: missionId,
          title: tree.title,
          description: tree.description ?? null,
          status: 'planning',
          autopilotEnabled: false,
          autopilotState: 'inactive',
          createdAt: now,
          updatedAt: now,
        })
        .run();

      tree.milestones.forEach((milestone, milestoneIndex) => {
        const milestoneId = randomUUID();
        tx.insert(milestones)
          .values({
            id: milestoneId,
            missionId,
            title: milestone.title,
            description: milestone.description ?? null,
            verification: milestone.verification,
            status: 'pending',
            orderIndex: milestoneIndex,
            createdAt: now,
            updatedAt: now,
          })
          .run();

        const featureIdByTitle = new Map<string, string>();

        milestone.slices.forEach((slice, sliceIndex) => {
          const sliceId = randomUUID();
          tx.insert(slices)
            .values({
              id: sliceId,
              milestoneId,
              title: slice.title,
              description: slice.description ?? null,
              verification: slice.verification,
              status: 'pending',
              orderIndex: sliceIndex,
              createdAt: now,
              updatedAt: now,
            })
            .run();

          slice.features.forEach((feature, featureIndex) => {
            const featureId = randomUUID();
            tx.insert(missionFeatures)
              .values({
                id: featureId,
                sliceId,
                title: feature.title,
                description: feature.description ?? null,
                acceptanceCriteria: JSON.stringify(feature.acceptanceCriteria),
                status: 'defined',
                loopState: 'idle',
                implementationAttemptCount: 0,
                validatorAttemptCount: 0,
                taskId: null,
                generatedFromFeatureId: null,
                generatedFromRunId: null,
                blockedReason: null,
                orderIndex: featureIndex,
                createdAt: now,
                updatedAt: now,
              })
              .run();
            featureIdByTitle.set(feature.title, featureId);
          });
        });

        const assertions = milestone.assertions ?? [];
        assertions.forEach((assertion, assertionIndex) => {
          const assertionId = randomUUID();
          const resolvedFeatureIds = assertion.featureIds.map(
            (titleOrId) => featureIdByTitle.get(titleOrId) ?? titleOrId,
          );
          tx.insert(missionContractAssertions)
            .values({
              id: assertionId,
              milestoneId,
              title: assertion.title,
              assertion: assertion.assertion,
              status: 'pending',
              orderIndex: assertionIndex,
              featureIds: JSON.stringify(resolvedFeatureIds),
              createdAt: now,
              updatedAt: now,
            })
            .run();
        });
      });

      const row = tx.select().from(missions).where(eq(missions.id, missionId)).get();
      if (!row) {
        throw new Error(`Mission ${missionId} not inserted.`);
      }
      return row;
    }),
  );
  emit(MissionEventName.MissionCreated, {
    missionId: inserted.id,
    mission: inserted,
  });
  return inserted;
}

//#endregion

//#region Linkage

export function linkFeatureToTask(cwd: string, featureId: string, taskId: string): void {
  const now = nowIso();
  const result = withDb(cwd, ({ db }) =>
    db.transaction((tx) => {
      const feature = tx
        .select()
        .from(missionFeatures)
        .where(eq(missionFeatures.id, featureId))
        .get();
      if (!feature) {
        throw new Error(`Feature ${featureId} not found.`);
      }
      const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (!task) {
        throw new Error(`Task ${taskId} not found.`);
      }

      const previousLoopState = feature.loopState;
      const incrementAttempt = previousLoopState === 'idle';
      const nextAttemptCount = incrementAttempt
        ? feature.implementationAttemptCount + 1
        : feature.implementationAttemptCount;

      tx.update(missionFeatures)
        .set({
          taskId,
          status: 'triaged',
          loopState: 'implementing',
          implementationAttemptCount: nextAttemptCount,
          updatedAt: now,
        })
        .where(eq(missionFeatures.id, featureId))
        .run();

      const sliceRow = tx.select().from(slices).where(eq(slices.id, feature.sliceId)).get();
      if (!sliceRow) {
        throw new Error(`Slice ${feature.sliceId} not found.`);
      }
      const milestoneRow = tx
        .select()
        .from(milestones)
        .where(eq(milestones.id, sliceRow.milestoneId))
        .get();
      if (!milestoneRow) {
        throw new Error(`Milestone ${sliceRow.milestoneId} not found.`);
      }

      tx.update(tasks)
        .set({
          missionId: milestoneRow.missionId,
          sliceId: feature.sliceId,
          featureId,
          updatedAt: now,
        })
        .where(eq(tasks.id, taskId))
        .run();

      const nextLoopState: FeatureLoopState = 'implementing';
      return {
        previousLoopState,
        nextLoopState,
        missionId: milestoneRow.missionId,
      };
    }),
  );
  emit(MissionEventName.FeatureLinkedToTask, {
    featureId,
    taskId,
    missionId: result.missionId,
  });
  if (result.previousLoopState !== result.nextLoopState) {
    emit(MissionEventName.FeatureLoopStateChanged, {
      featureId,
      previousLoopState: result.previousLoopState,
      loopState: result.nextLoopState,
    });
  }
}

//#endregion

//#region Triage

interface TriagedFeatureSummary {
  featureId: string;
  task: TaskRecord;
}

function buildPlaceholderTask(args: {
  feature: MissionFeatureRecord;
  missionId: string;
  projectRoot: string;
  now: string;
}): typeof tasks.$inferInsert {
  const taskId = randomUUID();
  const placeholderPath = `pending:mission/${args.missionId}/feature/${args.feature.id}`;
  return {
    id: taskId,
    projectRoot: args.projectRoot,
    worktreePath: placeholderPath,
    title: args.feature.title,
    branch: null,
    headSha: null,
    reviewStatus: 'not_started',
    status: 'active',
    source: 'git-worktree',
    cleanupReason: null,
    cleanupAt: null,
    provider: null,
    providerId: null,
    providerUrl: null,
    createdAt: args.now,
    updatedAt: args.now,
    lastSeenAt: args.now,
    missionId: args.missionId,
    sliceId: args.feature.sliceId,
    featureId: args.feature.id,
  };
}

function triageFeatureInTx(
  tx: DbTransaction,
  args: {
    feature: MissionFeatureRecord;
    missionId: string;
    projectRoot: string;
    now: string;
  },
): TriagedFeatureSummary {
  const taskInsert = buildPlaceholderTask(args);
  tx.insert(tasks).values(taskInsert).run();
  const previousLoopState = args.feature.loopState;
  const incrementAttempt = previousLoopState === 'idle';
  const nextAttemptCount = incrementAttempt
    ? args.feature.implementationAttemptCount + 1
    : args.feature.implementationAttemptCount;
  tx.update(missionFeatures)
    .set({
      taskId: taskInsert.id,
      status: 'triaged',
      loopState: 'implementing',
      implementationAttemptCount: nextAttemptCount,
      updatedAt: args.now,
    })
    .where(eq(missionFeatures.id, args.feature.id))
    .run();
  const insertedTask = tx.select().from(tasks).where(eq(tasks.id, taskInsert.id)).get();
  if (!insertedTask) {
    throw new Error(`Task ${taskInsert.id} not inserted.`);
  }
  return {
    featureId: args.feature.id,
    task: insertedTask,
  };
}

export function triageSlice(
  cwd: string,
  sliceId: string,
): {
  created: TaskRecord[];
  linkedFeatureIds: string[];
} {
  const now = nowIso();
  const summary = withDb(cwd, ({ db }) =>
    db.transaction((tx) => {
      const slice = tx.select().from(slices).where(eq(slices.id, sliceId)).get();
      if (!slice) {
        throw new Error(`Slice ${sliceId} not found.`);
      }
      const milestone = tx
        .select()
        .from(milestones)
        .where(eq(milestones.id, slice.milestoneId))
        .get();
      if (!milestone) {
        throw new Error(`Milestone ${slice.milestoneId} not found.`);
      }
      const features = tx
        .select()
        .from(missionFeatures)
        .where(and(eq(missionFeatures.sliceId, sliceId), isNull(missionFeatures.taskId)))
        .orderBy(asc(missionFeatures.orderIndex))
        .all();
      const summaries: TriagedFeatureSummary[] = features.map((feature) =>
        triageFeatureInTx(tx, {
          feature,
          missionId: milestone.missionId,
          projectRoot: cwd,
          now,
        }),
      );
      return {
        missionId: milestone.missionId,
        summaries,
      };
    }),
  );

  for (const item of summary.summaries) {
    emit(MissionEventName.FeatureLinkedToTask, {
      featureId: item.featureId,
      taskId: item.task.id,
      missionId: summary.missionId,
    });
    emit(MissionEventName.FeatureLoopStateChanged, {
      featureId: item.featureId,
      previousLoopState: 'idle',
      loopState: 'implementing',
    });
  }

  return {
    created: summary.summaries.map((entry) => entry.task),
    linkedFeatureIds: summary.summaries.map((entry) => entry.featureId),
  };
}

export function triageFeature(
  cwd: string,
  featureId: string,
): {
  task: TaskRecord;
} {
  const now = nowIso();
  const result = withDb(cwd, ({ db }) =>
    db.transaction((tx) => {
      const feature = tx
        .select()
        .from(missionFeatures)
        .where(eq(missionFeatures.id, featureId))
        .get();
      if (!feature) {
        throw new Error(`Feature ${featureId} not found.`);
      }
      if (feature.taskId !== null) {
        throw new Error(`Feature ${featureId} already linked to task ${feature.taskId}.`);
      }
      const slice = tx.select().from(slices).where(eq(slices.id, feature.sliceId)).get();
      if (!slice) {
        throw new Error(`Slice ${feature.sliceId} not found.`);
      }
      const milestone = tx
        .select()
        .from(milestones)
        .where(eq(milestones.id, slice.milestoneId))
        .get();
      if (!milestone) {
        throw new Error(`Milestone ${slice.milestoneId} not found.`);
      }
      const summary = triageFeatureInTx(tx, {
        feature,
        missionId: milestone.missionId,
        projectRoot: cwd,
        now,
      });
      return {
        missionId: milestone.missionId,
        previousLoopState: feature.loopState,
        ...summary,
      };
    }),
  );
  emit(MissionEventName.FeatureLinkedToTask, {
    featureId: result.featureId,
    taskId: result.task.id,
    missionId: result.missionId,
  });
  emit(MissionEventName.FeatureLoopStateChanged, {
    featureId: result.featureId,
    previousLoopState: result.previousLoopState,
    loopState: 'implementing',
  });
  return {
    task: result.task,
  };
}

//#endregion

//#region Activation

export function activateSlice(
  cwd: string,
  sliceId: string,
  opts: {
    triage?: boolean;
  } = {},
): void {
  const now = nowIso();
  const { shouldTriage } = withDb(cwd, ({ db }) => {
    const slice = requireSlice(db, sliceId);
    db.update(slices)
      .set({
        status: 'active',
        updatedAt: now,
      })
      .where(eq(slices.id, sliceId))
      .run();
    const missionId = findMissionIdForSlice(db, sliceId);
    const mission = requireMission(db, missionId);
    void slice;
    return {
      shouldTriage: opts.triage === true && mission.autopilotEnabled,
    };
  });
  if (shouldTriage) {
    triageSlice(cwd, sliceId);
  }
}

//#endregion

//#region Rollups

export function computeMissionStatus(cwd: string, missionId: string): MissionStatus {
  return withDb(cwd, ({ db }) => {
    const mission = requireMission(db, missionId);
    const milestoneRows = db
      .select()
      .from(milestones)
      .where(eq(milestones.missionId, missionId))
      .all();
    if (milestoneRows.length === 0) {
      return mission.status;
    }
    const allComplete = milestoneRows.every((row) => row.status === 'complete');
    if (allComplete) {
      return 'complete';
    }
    const anyBlocked = milestoneRows.some((row) => row.status === 'blocked');
    if (anyBlocked) {
      return 'blocked';
    }
    const anyActive = milestoneRows.some((row) => row.status === 'active');
    if (anyActive) {
      return 'active';
    }
    return mission.status;
  });
}

export function computeFeatureLoopState(cwd: string, featureId: string): FeatureLoopState {
  return withDb(cwd, ({ db }) => requireFeature(db, featureId).loopState);
}

export function getFeatureLoopSnapshot(cwd: string, featureId: string): FeatureLoopSnapshot {
  return withDb(cwd, ({ db }) => {
    const feature = requireFeature(db, featureId);
    const runs = db
      .select()
      .from(missionValidatorRuns)
      .where(eq(missionValidatorRuns.featureId, featureId))
      .orderBy(asc(missionValidatorRuns.startedAt))
      .all();
    const lineage = db
      .select()
      .from(missionFixFeatureLineage)
      .where(eq(missionFixFeatureLineage.sourceFeatureId, featureId))
      .all();
    const retryBudgetRemaining = Math.max(
      0,
      DEFAULT_IMPLEMENTATION_RETRY_BUDGET - feature.implementationAttemptCount,
    );
    return {
      feature,
      runs,
      lineage,
      retryBudgetRemaining,
    };
  });
}

//#endregion

//#region Fix-feature

export function createGeneratedFixFeature(
  cwd: string,
  args: {
    sourceFeatureId: string;
    validatorRunId: string;
  },
): MissionFeatureRecord {
  const now = nowIso();
  const result = withDb(cwd, ({ db }) =>
    db.transaction((tx) => {
      const source = tx
        .select()
        .from(missionFeatures)
        .where(eq(missionFeatures.id, args.sourceFeatureId))
        .get();
      if (!source) {
        throw new Error(`Source feature ${args.sourceFeatureId} not found.`);
      }
      if (source.implementationAttemptCount >= DEFAULT_IMPLEMENTATION_RETRY_BUDGET) {
        throw new BudgetExhaustedError(
          source.id,
          source.implementationAttemptCount,
          DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
        );
      }
      const validatorRun = tx
        .select()
        .from(missionValidatorRuns)
        .where(eq(missionValidatorRuns.id, args.validatorRunId))
        .get();
      if (!validatorRun) {
        throw new Error(`Validator run ${args.validatorRunId} not found.`);
      }

      const fixFeatureId = randomUUID();
      const lineageId = randomUUID();
      const nextOrderIndex =
        tx.select().from(missionFeatures).where(eq(missionFeatures.sliceId, source.sliceId)).all()
          .length + 1;

      tx.insert(missionFeatures)
        .values({
          id: fixFeatureId,
          sliceId: source.sliceId,
          title: `Fix: ${source.title}`,
          description: source.description,
          acceptanceCriteria: source.acceptanceCriteria,
          status: 'defined',
          loopState: 'idle',
          implementationAttemptCount: 0,
          validatorAttemptCount: 0,
          taskId: null,
          generatedFromFeatureId: source.id,
          generatedFromRunId: args.validatorRunId,
          blockedReason: null,
          orderIndex: nextOrderIndex,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const nextSourceAttemptCount = source.implementationAttemptCount + 1;
      tx.update(missionFeatures)
        .set({
          loopState: 'needs_fix',
          implementationAttemptCount: nextSourceAttemptCount,
          updatedAt: now,
        })
        .where(eq(missionFeatures.id, source.id))
        .run();

      tx.insert(missionFixFeatureLineage)
        .values({
          id: lineageId,
          sourceFeatureId: source.id,
          fixFeatureId,
          validatorRunId: args.validatorRunId,
          createdAt: now,
        })
        .run();

      const inserted = tx
        .select()
        .from(missionFeatures)
        .where(eq(missionFeatures.id, fixFeatureId))
        .get();
      if (!inserted) {
        throw new Error(`Fix feature ${fixFeatureId} not inserted.`);
      }
      return {
        previousSourceLoopState: source.loopState,
        sourceFeatureId: source.id,
        fixFeature: inserted,
        budgetRemaining: Math.max(0, DEFAULT_IMPLEMENTATION_RETRY_BUDGET - nextSourceAttemptCount),
      };
    }),
  );
  emit(MissionEventName.FeatureFixGenerated, {
    sourceFeatureId: result.sourceFeatureId,
    fixFeatureId: result.fixFeature.id,
    validatorRunId: args.validatorRunId,
    budgetRemaining: result.budgetRemaining,
  });
  if (result.previousSourceLoopState !== 'needs_fix') {
    emit(MissionEventName.FeatureLoopStateChanged, {
      featureId: result.sourceFeatureId,
      previousLoopState: result.previousSourceLoopState,
      loopState: 'needs_fix',
    });
  }
  if (result.budgetRemaining === 0) {
    emit(MissionEventName.FeatureBudgetExhausted, {
      featureId: result.sourceFeatureId,
      attemptCount: DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
      budget: DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
    });
  }
  return result.fixFeature;
}

//#endregion

//#region Validator runs

export function recordValidatorRun(
  cwd: string,
  args: {
    featureId: string;
    status: ValidatorRunStatus;
    resultJson?: unknown;
    pid?: number;
    pidStarttime?: string;
    startedAt?: string;
  },
): MissionValidatorRunRecord {
  const id = randomUUID();
  const startedAt = args.startedAt ?? nowIso();
  const now = nowIso();
  const completedAt = isTerminalRunStatus(args.status) ? now : null;
  const inserted = withDb(cwd, ({ db }) => {
    requireFeature(db, args.featureId);
    db.insert(missionValidatorRuns)
      .values({
        id,
        featureId: args.featureId,
        startedAt,
        completedAt,
        status: args.status,
        resultJson: args.resultJson === undefined ? null : JSON.stringify(args.resultJson),
        pid: args.pid ?? null,
        pidStarttime: args.pidStarttime ?? null,
        pausedAt: null,
      })
      .run();
    db.update(missionFeatures)
      .set({
        validatorAttemptCount:
          (db.select().from(missionFeatures).where(eq(missionFeatures.id, args.featureId)).get()
            ?.validatorAttemptCount ?? 0) + 1,
        updatedAt: now,
      })
      .where(eq(missionFeatures.id, args.featureId))
      .run();
    const row = db.select().from(missionValidatorRuns).where(eq(missionValidatorRuns.id, id)).get();
    if (!row) {
      throw new Error(`Validator run ${id} not inserted.`);
    }
    return row;
  });
  emit(MissionEventName.ValidatorRunRecorded, {
    runId: inserted.id,
    featureId: inserted.featureId,
    status: inserted.status,
  });
  return inserted;
}

function isTerminalRunStatus(status: ValidatorRunStatus): boolean {
  return status === 'pass' || status === 'fail' || status === 'blocked' || status === 'error';
}

export function updateValidatorRun(
  cwd: string,
  runId: string,
  patch: Partial<MissionValidatorRunRecord>,
): void {
  const now = nowIso();
  const updated = withDb(cwd, ({ db }) => {
    const existing = db
      .select()
      .from(missionValidatorRuns)
      .where(eq(missionValidatorRuns.id, runId))
      .get();
    if (!existing) {
      throw new Error(`Validator run ${runId} not found.`);
    }
    const completedAt =
      patch.status !== undefined && isTerminalRunStatus(patch.status)
        ? (patch.completedAt ?? now)
        : (patch.completedAt ?? existing.completedAt);
    db.update(missionValidatorRuns)
      .set({
        ...patch,
        id: existing.id,
        featureId: existing.featureId,
        startedAt: existing.startedAt,
        completedAt,
      })
      .where(eq(missionValidatorRuns.id, runId))
      .run();
    const row = db
      .select()
      .from(missionValidatorRuns)
      .where(eq(missionValidatorRuns.id, runId))
      .get();
    if (!row) {
      throw new Error(`Validator run ${runId} disappeared after update.`);
    }
    return row;
  });
  emit(MissionEventName.ValidatorRunRecorded, {
    runId: updated.id,
    featureId: updated.featureId,
    status: updated.status,
  });
}

//#endregion

//#region State transitions

export function markFeatureBlocked(cwd: string, featureId: string, reason?: string): void {
  const result = withDb(cwd, ({ db }) =>
    db.transaction((tx) => {
      const feature = tx
        .select()
        .from(missionFeatures)
        .where(eq(missionFeatures.id, featureId))
        .get();
      if (!feature) {
        throw new Error(`Feature ${featureId} not found.`);
      }
      const previousLoopState = feature.loopState;
      applyFeatureLoopStateUpdate({
        tx,
        featureId,
        newState: 'blocked',
        patch: {
          status: 'blocked',
          blockedReason: reason ?? null,
        },
      });
      return {
        previousLoopState,
      };
    }),
  );
  if (result.previousLoopState !== 'blocked') {
    emit(MissionEventName.FeatureLoopStateChanged, {
      featureId,
      previousLoopState: result.previousLoopState,
      loopState: 'blocked',
    });
  }
}

export function markFeaturePassed(cwd: string, featureId: string): void {
  const result = withDb(cwd, ({ db }) =>
    db.transaction((tx) => {
      const feature = tx
        .select()
        .from(missionFeatures)
        .where(eq(missionFeatures.id, featureId))
        .get();
      if (!feature) {
        throw new Error(`Feature ${featureId} not found.`);
      }
      const previousLoopState = feature.loopState;
      applyFeatureLoopStateUpdate({
        tx,
        featureId,
        newState: 'passed',
        patch: {
          status: 'done',
        },
      });
      return {
        previousLoopState,
        missionId: findMissionIdForFeature(tx, featureId),
      };
    }),
  );
  if (result.previousLoopState !== 'passed') {
    emit(MissionEventName.FeatureLoopStateChanged, {
      featureId,
      previousLoopState: result.previousLoopState,
      loopState: 'passed',
    });
  }
}

//#endregion
