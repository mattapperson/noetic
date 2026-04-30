import type { TaskStoreContext } from '../fs-store.js';
import type { Feature } from './schemas.js';
import { FeatureLoopState, FeatureStatus } from './schemas.js';
import { loadFeature, saveFeature } from './store.js';

//#region Types

export interface FeatureLifecycleContext extends TaskStoreContext {
  readonly taskId: string;
}

export interface ApplyLoopStateUpdate {
  readonly featureId: string;
  readonly newLoopState: FeatureLoopState;
  readonly statusOverride?: FeatureStatus;
  readonly blockedReason?: string | null;
}

export interface FeatureLoopStateChanged {
  readonly featureId: string;
  readonly previousLoopState: FeatureLoopState;
  readonly loopState: FeatureLoopState;
}

//#endregion

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

async function requireFeature(ctx: FeatureLifecycleContext, featureId: string): Promise<Feature> {
  const feature = await loadFeature(ctx, ctx.taskId, featureId);
  if (feature === null) {
    throw new Error(`Feature ${featureId} not found in task ${ctx.taskId}`);
  }
  return feature;
}

//#endregion

//#region Public API

/**
 * Atomically transition a feature into a new loop state. Mirrors the
 * legacy `applyFeatureLoopStateUpdate` — but without a SQL transaction,
 * since each feature lives in its own JSON file. The atomic write is
 * provided by the store's write-temp + rename.
 */
export async function applyFeatureLoopStateUpdate(
  ctx: FeatureLifecycleContext,
  update: ApplyLoopStateUpdate,
): Promise<{
  feature: Feature;
  changed: FeatureLoopStateChanged | null;
}> {
  const existing = await requireFeature(ctx, update.featureId);
  const previousLoopState = existing.loopState;
  const next: Feature = {
    ...existing,
    loopState: update.newLoopState,
    status: update.statusOverride ?? existing.status,
    blockedReason:
      update.blockedReason !== undefined ? update.blockedReason : existing.blockedReason,
    updatedAt: nowIso(),
  };
  await saveFeature(ctx, ctx.taskId, next);
  const changed: FeatureLoopStateChanged | null =
    previousLoopState === update.newLoopState
      ? null
      : {
          featureId: update.featureId,
          previousLoopState,
          loopState: update.newLoopState,
        };
  return {
    feature: next,
    changed,
  };
}

/** Mark a feature as having passed its validator (terminal success). */
export async function markFeaturePassed(
  ctx: FeatureLifecycleContext,
  featureId: string,
): Promise<FeatureLoopStateChanged | null> {
  const result = await applyFeatureLoopStateUpdate(ctx, {
    featureId,
    newLoopState: FeatureLoopState.Passed,
    statusOverride: FeatureStatus.Done,
  });
  return result.changed;
}

/** Mark a feature as blocked. */
export async function markFeatureBlocked(
  ctx: FeatureLifecycleContext,
  featureId: string,
  reason?: string,
): Promise<FeatureLoopStateChanged | null> {
  const result = await applyFeatureLoopStateUpdate(ctx, {
    featureId,
    newLoopState: FeatureLoopState.Blocked,
    statusOverride: FeatureStatus.Blocked,
    blockedReason: reason ?? null,
  });
  return result.changed;
}

//#endregion
