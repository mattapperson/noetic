import type { TaskStoreContext } from '../fs-store.js';
import { saveTask } from '../fs-store.js';
import type { Task } from '../schemas.js';
import {
  AutopilotState,
  generateTaskId,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '../schemas.js';
import type { Feature, FeatureLoopStateChanged } from './schemas.js';
import { FeatureLoopState, FeatureStatus } from './schemas.js';
import { listFeatures, loadFeature, loadSlice, saveFeature } from './store.js';

//#region Types

export interface TriageContext extends TaskStoreContext {
  readonly parentTaskId: string;
}

export interface TriagedSummary {
  readonly featureId: string;
  readonly task: Task;
  readonly previousLoopState: FeatureLoopState;
  readonly loopStateChanged: FeatureLoopStateChanged | null;
}

export interface TriageSliceResult {
  readonly summaries: TriagedSummary[];
  readonly created: Task[];
}

//#endregion

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build a placeholder leaf task for a feature. The worktree fields are
 * left null until something later actually provisions one. The leaf
 * task is `worktree`-sourced because every triaged feature is intended
 * to land in a worktree once an agent picks it up.
 */
function buildPlaceholderTask(args: { feature: Feature; projectRoot: string; now: string }): Task {
  return {
    id: generateTaskId(),
    source: TaskSource.Worktree,
    title: args.feature.title,
    projectRoot: args.projectRoot,
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
    createdAt: args.now,
    updatedAt: args.now,
    lastSeenAt: args.now,
  };
}

async function triageOne(
  ctx: TriageContext,
  feature: Feature,
  now: string,
): Promise<TriagedSummary> {
  const previousLoopState = feature.loopState;
  const incrementAttempt = previousLoopState === FeatureLoopState.Idle;
  const nextAttemptCount = incrementAttempt
    ? feature.implementationAttemptCount + 1
    : feature.implementationAttemptCount;

  const task = buildPlaceholderTask({
    feature,
    projectRoot: ctx.projectRoot,
    now,
  });
  await saveTask(ctx, task);

  const updatedFeature: Feature = {
    ...feature,
    taskId: task.id,
    status: FeatureStatus.Triaged,
    loopState: FeatureLoopState.Implementing,
    implementationAttemptCount: nextAttemptCount,
    updatedAt: now,
  };
  await saveFeature(ctx, ctx.parentTaskId, updatedFeature);

  const loopStateChanged: FeatureLoopStateChanged | null =
    previousLoopState === FeatureLoopState.Implementing
      ? null
      : {
          featureId: feature.id,
          previousLoopState,
          loopState: FeatureLoopState.Implementing,
        };

  return {
    featureId: feature.id,
    task,
    previousLoopState,
    loopStateChanged,
  };
}

//#endregion

//#region Public API

/**
 * Spin up a leaf task for every un-linked feature in a slice. Used by
 * the autopilot daemon when activating a slice. Mirrors the legacy
 * `triageSlice` modulo the SQL transaction.
 *
 * Order per feature: leaf task → updated feature. A torn write between
 * them leaves an orphan leaf without a feature backref, which an
 * idempotent re-run (or the daemon's reconcile) can mop up.
 */
export async function triageSlice(ctx: TriageContext, sliceId: string): Promise<TriageSliceResult> {
  const slice = await loadSlice(ctx, ctx.parentTaskId, sliceId);
  if (slice === null) {
    throw new Error(`Slice ${sliceId} not found in task ${ctx.parentTaskId}`);
  }
  const allFeatures = await listFeatures(ctx, ctx.parentTaskId);
  const candidates = allFeatures
    .filter((f) => f.sliceId === sliceId && f.taskId === null)
    .sort((a, b) => a.orderIndex - b.orderIndex);

  const now = nowIso();
  const summaries: TriagedSummary[] = [];
  for (const feature of candidates) {
    summaries.push(await triageOne(ctx, feature, now));
  }
  return {
    summaries,
    created: summaries.map((s) => s.task),
  };
}

/** Spin up a leaf task for one specific feature. */
export async function triageFeature(
  ctx: TriageContext,
  featureId: string,
): Promise<TriagedSummary> {
  const feature = await loadFeature(ctx, ctx.parentTaskId, featureId);
  if (feature === null) {
    throw new Error(`Feature ${featureId} not found in task ${ctx.parentTaskId}`);
  }
  if (feature.taskId !== null) {
    throw new Error(`Feature ${featureId} already linked to task ${feature.taskId}.`);
  }
  return triageOne(ctx, feature, nowIso());
}

//#endregion
