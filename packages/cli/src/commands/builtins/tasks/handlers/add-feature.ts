import { emitTaskEvent } from '../events.js';
import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent } from '../fs-store.js';
import type { Feature } from '../hierarchy/schemas.js';
import { FeatureLoopState, FeatureStatus, generateFeatureId } from '../hierarchy/schemas.js';
import { listFeatures, loadSlice, saveFeature } from '../hierarchy/store.js';
import { EventKind } from '../schemas.js';
import { nowIso, resolveTask } from './_shared.js';

//#region Types

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

//#endregion

//#region Public API

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
  const event = await appendEvent(ctx, {
    taskId: args.taskId,
    kind: EventKind.FeatureCreated,
    payload: {
      featureId: feature.id,
      sliceId: args.sliceId,
    },
    ts: now,
  });
  emitTaskEvent(event);
  return {
    feature,
  };
}

//#endregion
