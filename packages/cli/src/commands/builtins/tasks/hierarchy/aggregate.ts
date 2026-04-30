import type { TaskStoreContext } from '../fs-store.js';
import { hasHierarchy } from '../fs-store.js';
import type {
  Assertion,
  Feature,
  FeatureWithRuns,
  Milestone,
  MilestoneWithChildren,
  Slice,
  SliceWithFeatures,
  TaskHierarchy,
} from './schemas.js';
import { listAssertions, listFeatures, listMilestones, listSlices } from './store.js';
import { listValidatorRuns } from './validator.js';

//#region Helpers

function compareOrder<
  T extends {
    orderIndex: number;
    createdAt: string;
    id: string;
  },
>(a: T, b: T): number {
  if (a.orderIndex !== b.orderIndex) {
    return a.orderIndex - b.orderIndex;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return a.id < b.id ? -1 : 1;
}

async function attachRuns(
  ctx: TaskStoreContext,
  taskId: string,
  feature: Feature,
): Promise<FeatureWithRuns> {
  const runs = await listValidatorRuns(
    {
      ...ctx,
      taskId,
    },
    feature.id,
  );
  return {
    ...feature,
    validatorRuns: runs,
  };
}

function groupByOwner<T, K extends string>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket === undefined) {
      out.set(k, [
        item,
      ]);
      continue;
    }
    bucket.push(item);
  }
  return out;
}

//#endregion

//#region Public API

/**
 * Assemble the full hierarchy beneath a structured task. Returns null
 * when the task has no `hierarchy/` subtree (i.e. it's a leaf task).
 *
 * Reads each entity directory in parallel, then stitches them together
 * client-side using `milestoneId`/`sliceId` foreign keys. Equivalent to
 * the legacy `getMissionWithHierarchy`'s SQL joins but assembled from
 * file-per-record.
 */
export async function getTaskHierarchy(
  ctx: TaskStoreContext,
  taskId: string,
): Promise<TaskHierarchy | null> {
  if (!(await hasHierarchy(ctx, taskId))) {
    return null;
  }
  const [milestones, slices, features, assertions] = await Promise.all([
    listMilestones(ctx, taskId),
    listSlices(ctx, taskId),
    listFeatures(ctx, taskId),
    listAssertions(ctx, taskId),
  ]);
  const featuresWithRuns = await Promise.all(features.map((f) => attachRuns(ctx, taskId, f)));

  const slicesByMilestone = groupByOwner(slices, (s: Slice) => s.milestoneId);
  const featuresBySlice = groupByOwner(featuresWithRuns, (f: FeatureWithRuns) => f.sliceId);
  const assertionsByMilestone = groupByOwner(assertions, (a: Assertion) => a.milestoneId);

  const composed: MilestoneWithChildren[] = milestones
    .slice()
    .sort(compareOrder)
    .map((milestone: Milestone) => {
      const ms = (slicesByMilestone.get(milestone.id) ?? [])
        .slice()
        .sort(compareOrder)
        .map(
          (slice: Slice): SliceWithFeatures => ({
            ...slice,
            features: (featuresBySlice.get(slice.id) ?? []).slice().sort(compareOrder),
          }),
        );
      const ass = (assertionsByMilestone.get(milestone.id) ?? []).slice().sort(compareOrder);
      return {
        ...milestone,
        slices: ms,
        assertions: ass,
      };
    });

  return {
    taskId,
    milestones: composed,
  };
}

//#endregion
