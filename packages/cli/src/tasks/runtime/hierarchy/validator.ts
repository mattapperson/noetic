import { featureDirPaths, validatorRunPath } from '@noetic-tools/code-agent/tasks';
import * as path from '@noetic-tools/code-agent/tasks/path-utils';
import type { AssertionOutcome, Feature, ValidatorRun } from '@noetic-tools/code-agent/tasks/schema';
import {
  generateValidatorRunId,
  ValidatorRunIdSchema,
  ValidatorRunSchema,
  ValidatorRunStatus,
} from '@noetic-tools/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic-tools/code-agent/tasks/store/fs-node';
import { isEnoent, tempPath } from '@noetic-tools/code-agent/tasks/store/fs-node';
import { loadFeature, saveFeature } from './store.js';

//#region Types

export interface ValidatorContext extends TaskStoreContext {
  readonly taskId: string;
}

export interface RecordValidatorRunArgs {
  readonly featureId: string;
  readonly status: ValidatorRunStatus;
  readonly result?: Record<string, unknown> | null;
  readonly assertionOutcomes?: ReadonlyArray<AssertionOutcome>;
  readonly pid?: number | null;
  readonly pidStarttime?: string | null;
  readonly startedAt?: string;
}

export interface UpdateValidatorRunPatch {
  readonly status?: ValidatorRunStatus;
  readonly completedAt?: string | null;
  readonly result?: Record<string, unknown> | null;
  readonly assertionOutcomes?: ReadonlyArray<AssertionOutcome>;
  readonly pid?: number | null;
  readonly pidStarttime?: string | null;
  readonly pausedAt?: string | null;
}

//#endregion

//#region Helpers

const TERMINAL_STATUSES = new Set<ValidatorRunStatus>([
  ValidatorRunStatus.Pass,
  ValidatorRunStatus.Fail,
  ValidatorRunStatus.Blocked,
  ValidatorRunStatus.Error,
]);

function isTerminal(status: ValidatorRunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function nowIso(): string {
  return new Date().toISOString();
}

function randomSalt(): string {
  return Math.random().toString(36).slice(2, 12);
}

async function atomicWriteJson(
  ctx: ValidatorContext,
  target: string,
  value: unknown,
): Promise<void> {
  await ctx.fs.mkdir(path.dirname(target));
  const tmp = tempPath(target, randomSalt());
  await ctx.fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await ctx.fs.rename(tmp, target);
  } catch (err) {
    await ctx.fs.rm(tmp, {
      force: true,
    });
    throw err;
  }
}

async function readJson<T>(
  ctx: ValidatorContext,
  target: string,
  parse: (raw: unknown) => T,
): Promise<T | null> {
  let text: string;
  try {
    text = await ctx.fs.readFileText(target);
  } catch (err) {
    if (isEnoent(err)) {
      return null;
    }
    throw err;
  }
  if (text.length === 0) {
    return null;
  }
  return parse(JSON.parse(text));
}

async function bumpFeatureValidatorAttempt(
  ctx: ValidatorContext,
  featureId: string,
): Promise<Feature> {
  const feature = await loadFeature(ctx, ctx.taskId, featureId);
  if (feature === null) {
    throw new Error(`Feature ${featureId} not found in task ${ctx.taskId}`);
  }
  const next: Feature = {
    ...feature,
    validatorAttemptCount: feature.validatorAttemptCount + 1,
    updatedAt: nowIso(),
  };
  await saveFeature(ctx, ctx.taskId, next);
  return next;
}

//#endregion

//#region Public API

/**
 * Insert a new validator run for a feature and bump its
 * validatorAttemptCount. Order is: write run file, then update feature.
 * A torn second write leaves a real run with a stale count, which the
 * retry-budget check tolerates by under-counting (worst case: one extra
 * run before the budget engages).
 */
export async function recordValidatorRun(
  ctx: ValidatorContext,
  args: RecordValidatorRunArgs,
): Promise<ValidatorRun> {
  const id = generateValidatorRunId();
  const startedAt = args.startedAt ?? nowIso();
  const completedAt = isTerminal(args.status) ? startedAt : null;
  const run: ValidatorRun = ValidatorRunSchema.parse({
    id,
    featureId: args.featureId,
    startedAt,
    completedAt,
    status: args.status,
    result: args.result ?? null,
    assertionOutcomes: args.assertionOutcomes ?? [],
    pid: args.pid ?? null,
    pidStarttime: args.pidStarttime ?? null,
    pausedAt: null,
  });
  const target = validatorRunPath({
    ctx,
    taskId: ctx.taskId,
    featureId: args.featureId,
    runId: id,
  });
  await atomicWriteJson(ctx, target, run);
  await bumpFeatureValidatorAttempt(ctx, args.featureId);
  return run;
}

export interface UpdateValidatorRunArgs {
  readonly featureId: string;
  readonly runId: string;
  readonly patch: UpdateValidatorRunPatch;
}

/** Patch an existing validator run; terminal status sets `completedAt`. */
export async function updateValidatorRun(
  ctx: ValidatorContext,
  args: UpdateValidatorRunArgs,
): Promise<ValidatorRun> {
  const target = validatorRunPath({
    ctx,
    taskId: ctx.taskId,
    featureId: args.featureId,
    runId: args.runId,
  });
  const existing = await readJson<ValidatorRun>(ctx, target, (raw) =>
    ValidatorRunSchema.parse(raw),
  );
  if (existing === null) {
    throw new Error(`Validator run ${args.runId} not found for feature ${args.featureId}`);
  }
  const patch = args.patch;
  const nextStatus = patch.status ?? existing.status;
  const completedAt =
    patch.completedAt !== undefined
      ? patch.completedAt
      : isTerminal(nextStatus) && existing.completedAt === null
        ? nowIso()
        : existing.completedAt;
  const next: ValidatorRun = ValidatorRunSchema.parse({
    ...existing,
    ...patch,
    id: existing.id,
    featureId: existing.featureId,
    startedAt: existing.startedAt,
    status: nextStatus,
    completedAt,
  });
  await atomicWriteJson(ctx, target, next);
  return next;
}

export async function loadValidatorRun(
  ctx: ValidatorContext,
  featureId: string,
  runId: string,
): Promise<ValidatorRun | null> {
  if (!ValidatorRunIdSchema.safeParse(runId).success) {
    return null;
  }
  const target = validatorRunPath({
    ctx,
    taskId: ctx.taskId,
    featureId,
    runId,
  });
  return readJson<ValidatorRun>(ctx, target, (raw) => ValidatorRunSchema.parse(raw));
}

export async function listValidatorRuns(
  ctx: ValidatorContext,
  featureId: string,
): Promise<ValidatorRun[]> {
  const dirs = featureDirPaths(ctx, ctx.taskId, featureId);
  let entries: string[];
  try {
    entries = await ctx.fs.readdir(dirs.validatorRuns);
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }
  const runs: ValidatorRun[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }
    const id = entry.slice(0, -'.json'.length);
    if (!ValidatorRunIdSchema.safeParse(id).success) {
      continue;
    }
    const run = await loadValidatorRun(ctx, featureId, id);
    if (run !== null) {
      runs.push(run);
    }
  }
  // Stable order by startedAt (then id as tiebreaker).
  runs.sort((a, b) => {
    if (a.startedAt !== b.startedAt) {
      return a.startedAt < b.startedAt ? -1 : 1;
    }
    return a.id < b.id ? -1 : 1;
  });
  return runs;
}

//#endregion
