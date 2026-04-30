import path from 'node:path';

import { isEnoent } from '../_fs-errors.js';
import type { TaskStoreContext } from '../fs-store.js';
import { featureDirPaths } from './paths.js';
import type { Feature, FixLineage } from './schemas.js';
import {
  DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
  FeatureLoopState,
  FeatureStatus,
  FixLineageSchema,
  generateFeatureId,
  generateFixLineageId,
} from './schemas.js';
import { listFeatures, loadFeature, saveFeature } from './store.js';
import { loadValidatorRun } from './validator.js';

//#region Errors

/** Thrown by `createGeneratedFixFeature` when the source feature has no retry attempts left. */
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

//#region Types

export interface FixFeatureContext extends TaskStoreContext {
  readonly taskId: string;
}

export interface CreateFixFeatureArgs {
  readonly sourceFeatureId: string;
  readonly validatorRunId: string;
  /** Override the default implementation retry budget if needed. */
  readonly budget?: number;
}

export interface FixFeatureChange {
  readonly fixFeature: Feature;
  readonly sourcePreviousLoopState: FeatureLoopState;
  readonly sourceUpdated: Feature;
  /** How many implementation retries remain after this attempt. */
  readonly budgetRemaining: number;
}

//#endregion

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

async function nextOrderIndex(ctx: FixFeatureContext, sliceId: string): Promise<number> {
  const features = await listFeatures(ctx, ctx.taskId);
  const inSlice = features.filter((f) => f.sliceId === sliceId);
  if (inSlice.length === 0) {
    return 0;
  }
  let max = -1;
  for (const f of inSlice) {
    if (f.orderIndex > max) {
      max = f.orderIndex;
    }
  }
  return max + 1;
}

//#endregion

//#region Public API

/**
 * Read the append-only fix-lineage file for a feature.
 * Returns [] when the file does not exist (no fixes generated yet).
 */
export async function readFixLineage(
  ctx: FixFeatureContext,
  featureId: string,
): Promise<FixLineage[]> {
  const target = featureDirPaths(ctx.projectRoot, ctx.taskId, featureId).fixLineage;
  let raw: string;
  try {
    raw = await ctx.fs.readFileText(target);
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }
  const out: FixLineage[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    out.push(FixLineageSchema.parse(JSON.parse(line)));
  }
  return out;
}

async function appendFixLineage(
  ctx: FixFeatureContext,
  sourceFeatureId: string,
  entry: FixLineage,
): Promise<void> {
  const target = featureDirPaths(ctx.projectRoot, ctx.taskId, sourceFeatureId).fixLineage;
  await ctx.fs.mkdir(path.dirname(target));
  await ctx.fs.appendFile(target, `${JSON.stringify(entry)}\n`);
}

/**
 * Generate a fix feature for a failing source feature. Mirrors the
 * legacy `createGeneratedFixFeature`:
 *
 * 1. Refuse if source.implementationAttemptCount has hit budget
 *    (BudgetExhaustedError).
 * 2. Verify the cited validator run exists.
 * 3. Create a new feature in the same slice copying title / description /
 *    acceptance criteria, with `Fix: ` prefix and lineage backrefs to
 *    source + run.
 * 4. Bump source.implementationAttemptCount and flip its loopState to
 *    needs_fix.
 * 5. Append a FixLineage row to the source's fix-lineage.jsonl.
 *
 * Order of writes: fix feature → source feature → lineage. A torn
 * partial write leaves at most an orphan fix without a lineage entry,
 * which is observable but harmless. Returns budgetRemaining so the
 * caller can emit a feature:budgetExhausted signal when it hits 0.
 */
export async function createGeneratedFixFeature(
  ctx: FixFeatureContext,
  args: CreateFixFeatureArgs,
): Promise<FixFeatureChange> {
  const budget = args.budget ?? DEFAULT_IMPLEMENTATION_RETRY_BUDGET;
  const source = await loadFeature(ctx, ctx.taskId, args.sourceFeatureId);
  if (source === null) {
    throw new Error(`Source feature ${args.sourceFeatureId} not found.`);
  }
  if (source.implementationAttemptCount >= budget) {
    throw new BudgetExhaustedError(source.id, source.implementationAttemptCount, budget);
  }
  const validatorRun = await loadValidatorRun(ctx, args.sourceFeatureId, args.validatorRunId);
  if (validatorRun === null) {
    throw new Error(`Validator run ${args.validatorRunId} not found.`);
  }

  const now = nowIso();
  const fixFeatureId = generateFeatureId();
  const orderIndex = await nextOrderIndex(ctx, source.sliceId);
  const fixFeature: Feature = {
    id: fixFeatureId,
    sliceId: source.sliceId,
    title: `Fix: ${source.title}`,
    description: source.description,
    acceptanceCriteria: source.acceptanceCriteria,
    status: FeatureStatus.Defined,
    loopState: FeatureLoopState.Idle,
    implementationAttemptCount: 0,
    validatorAttemptCount: 0,
    taskId: null,
    generatedFromFeatureId: source.id,
    generatedFromRunId: args.validatorRunId,
    blockedReason: null,
    orderIndex,
    createdAt: now,
    updatedAt: now,
  };
  await saveFeature(ctx, ctx.taskId, fixFeature);

  const nextAttemptCount = source.implementationAttemptCount + 1;
  const sourceUpdated: Feature = {
    ...source,
    loopState: FeatureLoopState.NeedsFix,
    implementationAttemptCount: nextAttemptCount,
    updatedAt: now,
  };
  await saveFeature(ctx, ctx.taskId, sourceUpdated);

  const lineage: FixLineage = FixLineageSchema.parse({
    id: generateFixLineageId(),
    sourceFeatureId: source.id,
    fixFeatureId,
    validatorRunId: args.validatorRunId,
    createdAt: now,
  });
  await appendFixLineage(ctx, source.id, lineage);

  return {
    fixFeature,
    sourcePreviousLoopState: source.loopState,
    sourceUpdated,
    budgetRemaining: Math.max(0, budget - nextAttemptCount),
  };
}

//#endregion
