import type {
  Assertion,
  Feature,
  Milestone,
  Slice,
  TaskHierarchyInput,
} from '@noetic/code-agent/tasks/schema';
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
} from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { loadFeature, saveAssertion, saveFeature, saveMilestone, saveSlice } from './store.js';

//#region Types

export interface PersistedHierarchy {
  readonly milestones: Milestone[];
  readonly slices: Slice[];
  readonly features: Feature[];
  readonly assertions: Assertion[];
}

//#endregion

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

//#endregion

//#region Public API

/**
 * Bulk-create a task's hierarchy from structured interview output.
 * Mirrors the legacy `persistMissionTree` shape: each milestone has
 * slices and assertions; each slice has features. Assertion
 * `featureIndices` are 0-based offsets into the slice's `features`
 * array — they get resolved into real feature IDs as we go.
 *
 * The on-disk writes happen leaf-first (features → slices →
 * milestones → assertions) so that if a write fails partway through,
 * `getTaskHierarchy` running concurrently sees consistent owners for
 * everything it lists. (We can't do a SQL-style transaction; the
 * tradeoff is that a partial failure can leave orphaned files, which
 * `getTaskHierarchy` filters out.)
 */
export async function persistTaskHierarchy(
  ctx: TaskStoreContext,
  taskId: string,
  tree: TaskHierarchyInput,
): Promise<PersistedHierarchy> {
  const now = nowIso();
  const milestones: Milestone[] = [];
  const slices: Slice[] = [];
  const features: Feature[] = [];
  const assertions: Assertion[] = [];

  for (let mi = 0; mi < tree.milestones.length; mi++) {
    const milestoneInput = tree.milestones[mi];
    if (milestoneInput === undefined) {
      continue;
    }
    const milestoneId = generateMilestoneId();
    const milestone: Milestone = {
      id: milestoneId,
      taskId,
      title: milestoneInput.title,
      description: milestoneInput.description ?? null,
      verification: milestoneInput.verification,
      status: MilestoneStatus.Pending,
      orderIndex: mi,
      createdAt: now,
      updatedAt: now,
    };

    // Per-milestone feature index → resolved feature id, used when
    // resolving assertion `featureIndices` references.
    const featureIdByMilestoneIndex = new Map<number, string>();
    let featureIndexCounter = 0;

    for (let si = 0; si < milestoneInput.slices.length; si++) {
      const sliceInput = milestoneInput.slices[si];
      if (sliceInput === undefined) {
        continue;
      }
      const sliceId = generateSliceId();
      const slice: Slice = {
        id: sliceId,
        milestoneId,
        title: sliceInput.title,
        description: sliceInput.description ?? null,
        verification: sliceInput.verification,
        status: SliceStatus.Pending,
        orderIndex: si,
        createdAt: now,
        updatedAt: now,
      };

      for (let fi = 0; fi < sliceInput.features.length; fi++) {
        const featureInput = sliceInput.features[fi];
        if (featureInput === undefined) {
          continue;
        }
        const featureId = generateFeatureId();
        const feature: Feature = {
          id: featureId,
          sliceId,
          title: featureInput.title,
          description: featureInput.description ?? null,
          acceptanceCriteria: featureInput.acceptanceCriteria,
          status: FeatureStatus.Defined,
          loopState: FeatureLoopState.Idle,
          implementationAttemptCount: 0,
          validatorAttemptCount: 0,
          taskId: null,
          generatedFromFeatureId: null,
          generatedFromRunId: null,
          blockedReason: null,
          orderIndex: fi,
          createdAt: now,
          updatedAt: now,
        };
        await saveFeature(ctx, taskId, feature);
        features.push(feature);
        featureIdByMilestoneIndex.set(featureIndexCounter, featureId);
        featureIndexCounter += 1;
      }

      await saveSlice(ctx, taskId, slice);
      slices.push(slice);
    }

    await saveMilestone(ctx, taskId, milestone);
    milestones.push(milestone);

    for (let ai = 0; ai < milestoneInput.assertions.length; ai++) {
      const assertionInput = milestoneInput.assertions[ai];
      if (assertionInput === undefined) {
        continue;
      }
      const featureIds: string[] = [];
      for (const idx of assertionInput.featureIndices) {
        const resolved = featureIdByMilestoneIndex.get(idx);
        if (resolved !== undefined) {
          featureIds.push(resolved);
        }
      }
      const assertion: Assertion = {
        id: generateAssertionId(),
        milestoneId,
        title: assertionInput.title,
        assertion: assertionInput.assertion,
        status: AssertionStatus.Pending,
        orderIndex: ai,
        featureIds,
        createdAt: now,
        updatedAt: now,
      };
      await saveAssertion(ctx, taskId, assertion);
      assertions.push(assertion);
    }
  }

  return {
    milestones,
    slices,
    features,
    assertions,
  };
}

//#endregion

//#region Linkage

/**
 * Link a hierarchy feature to a leaf task that has been spun up to
 * implement it. The leaf task's `id` is recorded on the feature.
 */
export async function linkFeatureToTask(
  ctx: TaskStoreContext,
  args: {
    parentTaskId: string;
    featureId: string;
    leafTaskId: string;
  },
): Promise<Feature> {
  const existing = await loadFeature(ctx, args.parentTaskId, args.featureId);
  if (existing === null) {
    throw new Error(`Feature ${args.featureId} not found in task ${args.parentTaskId}`);
  }
  const next: Feature = {
    ...existing,
    taskId: args.leafTaskId,
    updatedAt: nowIso(),
  };
  await saveFeature(ctx, args.parentTaskId, next);
  return next;
}

//#endregion
