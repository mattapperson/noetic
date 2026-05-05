import { featureDirPaths } from '@noetic/code-agent/tasks';
import * as path from '@noetic/code-agent/tasks/path-utils';
import type { Feature, FixLineage, ValidatorRun } from '@noetic/code-agent/tasks/schema';
import {
  AssertionStatus,
  DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
  FeatureLoopState,
  FeatureStatus,
  FixLineageSchema,
  generateFeatureId,
  generateFixLineageId,
} from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import { isEnoent } from '@noetic/code-agent/tasks/store/fs-node';
import type { AgentHarness, ContextMemory, Step } from '@noetic/core';
import { branch, step } from '@noetic/core';
import { listFeatures, loadFeature, saveFeature } from './store.js';
import { loadValidatorRun } from './validator.js';

/** Project the failing-assertion ids out of a validator run for the lineage record. */
function failedAssertionIdsFromRun(run: ValidatorRun): string[] {
  const out: string[] = [];
  for (const outcome of run.assertionOutcomes) {
    if (outcome.status === AssertionStatus.Failed) {
      out.push(outcome.assertionId);
    }
  }
  return out;
}

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
  /** Failing assertion ids carried from the triggering validator run. */
  readonly failedAssertionIds: ReadonlyArray<string>;
}

/** Bundle the imperative store context with the flow args so steps can share it. */
export interface FixFeatureFlowInput {
  readonly ctx: FixFeatureContext;
  readonly sourceFeatureId: string;
  readonly validatorRunId: string;
  readonly budget?: number;
}

interface ApplyCreateFixFeatureArgs {
  readonly ctx: FixFeatureContext;
  readonly source: Feature;
  readonly validatorRunId: string;
  readonly budget: number;
}

/** Output of the load-and-check step; consumed by the budget branch. */
interface LoadAndCheckResult {
  readonly ctx: FixFeatureContext;
  readonly source: Feature;
  readonly budget: number;
  readonly validatorRunId: string;
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

async function appendFixLineage(
  ctx: FixFeatureContext,
  sourceFeatureId: string,
  entry: FixLineage,
): Promise<void> {
  const target = featureDirPaths(ctx, ctx.taskId, sourceFeatureId).fixLineage;
  await ctx.fs.mkdir(path.dirname(target));
  await ctx.fs.appendFile(target, `${JSON.stringify(entry)}\n`);
}

/**
 * Imperative kernel for the create-fix-feature happy path. Shared by the
 * `createFixFeatureStep` flow node and the {@link createGeneratedFixFeature}
 * fallback so both code paths produce identical state.
 *
 * Caller has already proven `source.implementationAttemptCount < budget`
 * via {@link loadAndCheckBudget}.
 */
async function applyCreateFixFeature(args: ApplyCreateFixFeatureArgs): Promise<FixFeatureChange> {
  const { ctx, source, validatorRunId, budget } = args;
  const validatorRun = await loadValidatorRun(ctx, source.id, validatorRunId);
  if (validatorRun === null) {
    throw new Error(`Validator run ${validatorRunId} not found.`);
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
    generatedFromRunId: validatorRunId,
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

  const failedAssertionIds = failedAssertionIdsFromRun(validatorRun);
  const lineage: FixLineage = FixLineageSchema.parse({
    id: generateFixLineageId(),
    sourceFeatureId: source.id,
    fixFeatureId,
    validatorRunId,
    failedAssertionIds,
    createdAt: now,
  });
  await appendFixLineage(ctx, source.id, lineage);

  return {
    fixFeature,
    sourcePreviousLoopState: source.loopState,
    sourceUpdated,
    budgetRemaining: Math.max(0, budget - nextAttemptCount),
    failedAssertionIds,
  };
}

/**
 * Imperative load-and-budget-check used by both the `loadAndCheckBudgetStep`
 * flow node and the fallback path. Throws if the source feature is missing.
 */
async function loadAndCheckBudget(input: FixFeatureFlowInput): Promise<LoadAndCheckResult> {
  const budget = input.budget ?? DEFAULT_IMPLEMENTATION_RETRY_BUDGET;
  const source = await loadFeature(input.ctx, input.ctx.taskId, input.sourceFeatureId);
  if (source === null) {
    throw new Error(`Source feature ${input.sourceFeatureId} not found.`);
  }
  return {
    ctx: input.ctx,
    source,
    budget,
    validatorRunId: input.validatorRunId,
  };
}

//#endregion

//#region Flow steps

/**
 * Load the source feature and resolve the effective retry budget.
 * Throws when the source feature is missing.
 */
const loadAndCheckBudgetStep = step.run<ContextMemory, FixFeatureFlowInput, LoadAndCheckResult>({
  id: 'fix-feature.load-and-check',
  execute: async (input) => loadAndCheckBudget(input),
});

/**
 * Happy-path branch: write the new fix feature, bump the source attempt
 * counter, and append a fix-lineage row.
 */
const createFixFeatureStep = step.run<ContextMemory, LoadAndCheckResult, FixFeatureChange>({
  id: 'fix-feature.create',
  execute: async (input) =>
    applyCreateFixFeature({
      ctx: input.ctx,
      source: input.source,
      validatorRunId: input.validatorRunId,
      budget: input.budget,
    }),
});

/**
 * Budget-exhausted branch: surface a typed `BudgetExhaustedError`. The
 * actual `markFeatureBlocked` side-effect is the caller's responsibility
 * (validator-job's catch handler does it and emits the
 * feature:loopStateChanged event), so the step intentionally only signals
 * the budget verdict. The step never returns — the FixFeatureChange in
 * the type signature is satisfied by the throw.
 */
const markBudgetExhaustedStep = step.run<ContextMemory, LoadAndCheckResult, FixFeatureChange>({
  id: 'fix-feature.mark-budget-exhausted',
  execute: async (input) => {
    throw new BudgetExhaustedError(
      input.source.id,
      input.source.implementationAttemptCount,
      input.budget,
    );
  },
});

/**
 * Route between the two terminal steps based on whether the source feature
 * has hit its retry budget. Mirrors the predicate from the legacy
 * `createGeneratedFixFeature` body.
 */
const budgetBranch = branch<ContextMemory, LoadAndCheckResult, FixFeatureChange>({
  id: 'fix-feature.budget-decision',
  route: (input) => {
    if (input.source.implementationAttemptCount >= input.budget) {
      return markBudgetExhaustedStep;
    }
    return createFixFeatureStep;
  },
});

/**
 * Two-step composition wrapping load-and-check followed by the budget
 * branch. The wrapper is a `step.run` that drives the sub-steps via
 * `harness.run` — each sub-step still emits its own span via the
 * interpreter. Errors thrown from the sub-steps surface as
 * `NoeticError(step_failed)` whose `cause` chain ends in the underlying
 * domain error (e.g. `BudgetExhaustedError`); callers should walk the
 * chain (see the test helper `unwrapNoeticError`).
 */
export const fixFeatureFlow: Step<ContextMemory, FixFeatureFlowInput, FixFeatureChange> = step.run<
  ContextMemory,
  FixFeatureFlowInput,
  FixFeatureChange
>({
  id: 'fix-feature.flow',
  execute: async (input, ctx) => {
    const checked = await ctx.harness.run(loadAndCheckBudgetStep, input, ctx);
    return ctx.harness.run(budgetBranch, checked, ctx);
  },
});

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
  const target = featureDirPaths(ctx, ctx.taskId, featureId).fixLineage;
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

/**
 * Imperative fallback used when no `AgentHarness` is in scope. Mirrors the
 * step bodies of {@link fixFeatureFlow} so both code paths produce identical
 * state — the flow path emits per-step spans, the fallback path doesn't.
 */
async function executeFixFeatureFallback(
  ctx: FixFeatureContext,
  args: CreateFixFeatureArgs,
): Promise<FixFeatureChange> {
  const checked = await loadAndCheckBudget({
    ctx,
    sourceFeatureId: args.sourceFeatureId,
    validatorRunId: args.validatorRunId,
    budget: args.budget,
  });
  if (checked.source.implementationAttemptCount >= checked.budget) {
    throw new BudgetExhaustedError(
      checked.source.id,
      checked.source.implementationAttemptCount,
      checked.budget,
    );
  }
  return applyCreateFixFeature({
    ctx: checked.ctx,
    source: checked.source,
    validatorRunId: checked.validatorRunId,
    budget: checked.budget,
  });
}

/**
 * Generate a fix feature for a failing source feature. Mirrors the
 * legacy `createGeneratedFixFeature`:
 *
 * 1. Refuse if source.implementationAttemptCount has hit budget
 *    (BudgetExhaustedError, with the source marked blocked).
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
 *
 * When `harness` is provided, the work runs through {@link fixFeatureFlow}
 * (so each step emits a trace span). Otherwise the fallback path is used,
 * which is what existing imperative call sites expect.
 */
export async function createGeneratedFixFeature(
  ctx: FixFeatureContext,
  args: CreateFixFeatureArgs,
  harness?: AgentHarness,
): Promise<FixFeatureChange> {
  if (harness !== undefined) {
    const childCtx = harness.createContext();
    return harness.run(
      fixFeatureFlow,
      {
        ctx,
        sourceFeatureId: args.sourceFeatureId,
        validatorRunId: args.validatorRunId,
        budget: args.budget,
      },
      childCtx,
    );
  }
  return executeFixFeatureFallback(ctx, args);
}

//#endregion
