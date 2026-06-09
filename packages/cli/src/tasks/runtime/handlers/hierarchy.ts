/**
 * Hierarchy-shape handlers: add-feature, add-milestone, add-slice,
 * add-assertion, activate-slice.
 */

import { EventKind } from '@noetic-tools/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic-tools/code-agent/tasks/store/fs-node';
import { appendEvent } from '@noetic-tools/code-agent/tasks/store/fs-node';
import type { ActivateSliceResult } from '../hierarchy/activation.js';
import { activateSlice } from '../hierarchy/activation.js';
import { hierarchyPaths } from '../hierarchy/paths.js';
import type { Assertion, Feature, Milestone, Slice } from '../hierarchy/schemas.js';
import {
  AssertionStatus,
  FeatureLoopState,
  FeatureStatus,
  generateAssertionId,
  generateFeatureId,
  generateMilestoneId,
  generateSliceId,
  MilestoneStatus,
  SliceStatus,
} from '../hierarchy/schemas.js';
import {
  listAssertions,
  listFeatures,
  listMilestones,
  listSlices,
  loadMilestone,
  loadSlice,
  saveAssertion,
  saveFeature,
  saveMilestone,
  saveSlice,
} from '../hierarchy/store.js';
import { nowIso, resolveTask } from './_shared.js';

//#region add-feature

export interface AddFeatureArgs {
  readonly taskId: string;
  readonly sliceId: string;
  readonly title: string;
  readonly acceptanceCriteria: string;
  readonly description?: string;
}

export interface AddFeatureResult {
  readonly feature: Feature;
}

/** Append a feature under an existing slice. */
export async function addFeatureHandler(
  ctx: TaskStoreContext,
  args: AddFeatureArgs,
): Promise<AddFeatureResult> {
  await resolveTask(ctx, args.taskId);
  const slice = await loadSlice(ctx, args.taskId, args.sliceId);
  if (slice === null) {
    throw new Error(`Slice ${args.sliceId} not found in task ${args.taskId}`);
  }
  const trimmed = args.title.trim();
  if (trimmed.length === 0) {
    throw new Error('Feature title must not be empty');
  }
  const allFeatures = await listFeatures(ctx, args.taskId);
  const siblingCount = allFeatures.filter((f) => f.sliceId === args.sliceId).length;
  const now = nowIso();
  const feature: Feature = {
    id: generateFeatureId(),
    sliceId: args.sliceId,
    title: trimmed,
    description: args.description ?? null,
    acceptanceCriteria: args.acceptanceCriteria,
    status: FeatureStatus.Defined,
    loopState: FeatureLoopState.Idle,
    implementationAttemptCount: 0,
    validatorAttemptCount: 0,
    taskId: null,
    generatedFromFeatureId: null,
    generatedFromRunId: null,
    blockedReason: null,
    orderIndex: siblingCount,
    createdAt: now,
    updatedAt: now,
  };
  await saveFeature(ctx, args.taskId, feature);
  await appendEvent(ctx, {
    taskId: args.taskId,
    kind: EventKind.FeatureCreated,
    payload: {
      featureId: feature.id,
      sliceId: args.sliceId,
    },
    ts: now,
  });
  return {
    feature,
  };
}

//#endregion

//#region add-milestone

export interface AddMilestoneArgs {
  readonly taskId: string;
  readonly title: string;
  readonly verification: string;
  readonly description?: string;
}

export interface AddMilestoneResult {
  readonly milestone: Milestone;
}

/**
 * Append a milestone to a task's hierarchy. Creates the
 * `hierarchy/milestones` directory on first call so a freshly-planned
 * task does not need an explicit init step.
 */
export async function addMilestoneHandler(
  ctx: TaskStoreContext,
  args: AddMilestoneArgs,
): Promise<AddMilestoneResult> {
  await resolveTask(ctx, args.taskId);
  const trimmed = args.title.trim();
  if (trimmed.length === 0) {
    throw new Error('Milestone title must not be empty');
  }
  const paths = hierarchyPaths(ctx, args.taskId);
  await ctx.fs.mkdir(paths.milestones);
  const existing = await listMilestones(ctx, args.taskId);
  const now = nowIso();
  const milestone: Milestone = {
    id: generateMilestoneId(),
    taskId: args.taskId,
    title: trimmed,
    description: args.description ?? null,
    verification: args.verification,
    status: MilestoneStatus.Pending,
    orderIndex: existing.length,
    createdAt: now,
    updatedAt: now,
  };
  await saveMilestone(ctx, args.taskId, milestone);
  await appendEvent(ctx, {
    taskId: args.taskId,
    kind: EventKind.MilestoneCreated,
    payload: {
      milestoneId: milestone.id,
    },
    ts: now,
  });
  return {
    milestone,
  };
}

//#endregion

//#region add-slice

export interface AddSliceArgs {
  readonly taskId: string;
  readonly milestoneId: string;
  readonly title: string;
  readonly verification: string;
  readonly description?: string;
}

export interface AddSliceResult {
  readonly slice: Slice;
}

/**
 * Append a slice under an existing milestone. Order index is the
 * count of sibling slices on the same milestone, so callers don't need
 * to compute it themselves.
 */
export async function addSliceHandler(
  ctx: TaskStoreContext,
  args: AddSliceArgs,
): Promise<AddSliceResult> {
  await resolveTask(ctx, args.taskId);
  const milestone = await loadMilestone(ctx, args.taskId, args.milestoneId);
  if (milestone === null) {
    throw new Error(`Milestone ${args.milestoneId} not found in task ${args.taskId}`);
  }
  const trimmed = args.title.trim();
  if (trimmed.length === 0) {
    throw new Error('Slice title must not be empty');
  }
  const allSlices = await listSlices(ctx, args.taskId);
  const siblingCount = allSlices.filter((s) => s.milestoneId === args.milestoneId).length;
  const now = nowIso();
  const slice: Slice = {
    id: generateSliceId(),
    milestoneId: args.milestoneId,
    title: trimmed,
    description: args.description ?? null,
    verification: args.verification,
    status: SliceStatus.Pending,
    orderIndex: siblingCount,
    createdAt: now,
    updatedAt: now,
  };
  await saveSlice(ctx, args.taskId, slice);
  await appendEvent(ctx, {
    taskId: args.taskId,
    kind: EventKind.SliceCreated,
    payload: {
      sliceId: slice.id,
      milestoneId: args.milestoneId,
    },
    ts: now,
  });
  return {
    slice,
  };
}

//#endregion

//#region add-assertion

export interface AddAssertionArgs {
  readonly taskId: string;
  readonly milestoneId: string;
  readonly title: string;
  readonly assertion: string;
  readonly featureIds?: ReadonlyArray<string>;
}

export interface AddAssertionResult {
  readonly assertion: Assertion;
}

/** Append an assertion under an existing milestone. */
export async function addAssertionHandler(
  ctx: TaskStoreContext,
  args: AddAssertionArgs,
): Promise<AddAssertionResult> {
  await resolveTask(ctx, args.taskId);
  const milestone = await loadMilestone(ctx, args.taskId, args.milestoneId);
  if (milestone === null) {
    throw new Error(`Milestone ${args.milestoneId} not found in task ${args.taskId}`);
  }
  const trimmed = args.title.trim();
  if (trimmed.length === 0) {
    throw new Error('Assertion title must not be empty');
  }
  const allAssertions = await listAssertions(ctx, args.taskId);
  const siblingCount = allAssertions.filter((a) => a.milestoneId === args.milestoneId).length;
  const now = nowIso();
  const assertion: Assertion = {
    id: generateAssertionId(),
    milestoneId: args.milestoneId,
    title: trimmed,
    assertion: args.assertion,
    status: AssertionStatus.Pending,
    orderIndex: siblingCount,
    featureIds: [
      ...(args.featureIds ?? []),
    ],
    createdAt: now,
    updatedAt: now,
  };
  await saveAssertion(ctx, args.taskId, assertion);
  await appendEvent(ctx, {
    taskId: args.taskId,
    kind: EventKind.AssertionCreated,
    payload: {
      assertionId: assertion.id,
      milestoneId: args.milestoneId,
    },
    ts: now,
  });
  return {
    assertion,
  };
}

//#endregion

//#region activate-slice

export interface ActivateSliceHandlerArgs {
  readonly taskId: string;
  readonly sliceId: string;
  /**
   * If `triage` is omitted, the parent task's `autopilotEnabled` flag
   * picks the default — autopilot-on tasks triage every un-linked
   * feature in the slice; manual tasks just flip the slice's status.
   */
  readonly triage?: boolean;
}

export interface ActivateSliceHandlerResult {
  readonly outcome: ActivateSliceResult;
}

/**
 * Mark a slice active. When the parent task has `autopilotEnabled`
 * (and the caller did not pass an explicit `triage` flag), every
 * un-linked feature in the slice is triaged into a placeholder leaf
 * task in the same call.
 */
export async function activateSliceHandler(
  ctx: TaskStoreContext,
  args: ActivateSliceHandlerArgs,
): Promise<ActivateSliceHandlerResult> {
  const task = await resolveTask(ctx, args.taskId);
  const triage = args.triage ?? task.autopilotEnabled;
  const outcome = await activateSlice(ctx, {
    parentTaskId: args.taskId,
    sliceId: args.sliceId,
    triage,
  });
  return {
    outcome,
  };
}

//#endregion
