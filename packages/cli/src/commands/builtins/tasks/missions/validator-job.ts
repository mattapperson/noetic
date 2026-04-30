import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Context } from '@noetic/core';
import { and, asc, eq, isNull } from 'drizzle-orm';

import type { JobDefinition } from '../../../../daemon-runtime/jobs.js';
import * as log from '../../../../util/log.js';
import type {
  MissionContractAssertionRecord,
  MissionFeatureRecord,
  MissionValidatorRunRecord,
  TaskRecord,
} from '../db/schema.js';
import {
  milestones,
  missionContractAssertions,
  missionFeatures,
  missionValidatorRuns,
  slices,
  tasks,
} from '../db/schema.js';
import type { AutopilotDeps } from './autopilot.js';
import {
  BudgetExhaustedError,
  createGeneratedFixFeature,
  markFeatureBlocked,
  markFeaturePassed,
  triageFeature,
  updateValidatorRun,
  withMissionsDb,
} from './store.js';
import type { ValidatorRunResult } from './validator.js';
import { runValidator } from './validator.js';

//#region Constants

const VALIDATOR_TICK_INTERVAL_MS = 30_000;

//#endregion

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

function loadRunningValidatorRuns(cwd: string): MissionValidatorRunRecord[] {
  return withMissionsDb(cwd, ({ db }) =>
    db.select().from(missionValidatorRuns).where(eq(missionValidatorRuns.status, 'running')).all(),
  );
}

function loadValidatingFeatures(cwd: string): MissionFeatureRecord[] {
  return withMissionsDb(cwd, ({ db }) =>
    db
      .select()
      .from(missionFeatures)
      .where(eq(missionFeatures.loopState, 'validating'))
      .orderBy(asc(missionFeatures.updatedAt))
      .all(),
  );
}

function hasInflightRun(cwd: string, featureId: string): boolean {
  return withMissionsDb(cwd, ({ db }) => {
    const row = db
      .select()
      .from(missionValidatorRuns)
      .where(
        and(
          eq(missionValidatorRuns.featureId, featureId),
          eq(missionValidatorRuns.status, 'running'),
          isNull(missionValidatorRuns.completedAt),
        ),
      )
      .get();
    return row !== undefined;
  });
}

function loadAssertionsForFeature(
  cwd: string,
  feature: MissionFeatureRecord,
): MissionContractAssertionRecord[] {
  return withMissionsDb(cwd, ({ db }) => {
    const sliceRow = db.select().from(slices).where(eq(slices.id, feature.sliceId)).get();
    if (!sliceRow) {
      return [];
    }
    const milestoneRow = db
      .select()
      .from(milestones)
      .where(eq(milestones.id, sliceRow.milestoneId))
      .get();
    if (!milestoneRow) {
      return [];
    }
    return db
      .select()
      .from(missionContractAssertions)
      .where(eq(missionContractAssertions.milestoneId, milestoneRow.id))
      .all()
      .filter((assertion) => assertionAppliesToFeature(assertion, feature.id));
  });
}

function assertionAppliesToFeature(
  assertion: MissionContractAssertionRecord,
  featureId: string,
): boolean {
  try {
    const featureIds = JSON.parse(assertion.featureIds);
    if (!Array.isArray(featureIds)) {
      return false;
    }
    if (featureIds.length === 0) {
      return true;
    }
    return featureIds.includes(featureId);
  } catch {
    return false;
  }
}

function loadTaskForFeature(cwd: string, taskId: string): TaskRecord | null {
  return withMissionsDb(cwd, ({ db }) => {
    const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    return row ?? null;
  });
}

interface BuildContextArgs {
  task: TaskRecord;
}

async function buildTaskContextBlob(args: BuildContextArgs): Promise<string> {
  const blocks: string[] = [];
  const worktreePath = args.task.worktreePath;
  blocks.push(
    `# Task ${args.task.id}\nworktreePath: ${worktreePath}\nbranch: ${args.task.branch ?? '<none>'}`,
  );
  if (worktreePath.startsWith('pending:')) {
    blocks.push('## diff\n<no worktree available — task placeholder>');
  } else {
    blocks.push(`## diff\n${safeGitDiff(worktreePath)}`);
    const promptMd = await safeReadPromptMd(worktreePath);
    if (promptMd !== null) {
      blocks.push(`## PROMPT.md\n${promptMd}`);
    }
  }
  return blocks.join('\n\n');
}

function safeGitDiff(cwd: string): string {
  try {
    return execFileSync(
      'git',
      [
        'diff',
        '--no-color',
        '--unified=3',
      ],
      {
        cwd,
        encoding: 'utf8',
        stdio: [
          'ignore',
          'pipe',
          'ignore',
        ],
      },
    );
  } catch (err) {
    return `<git diff failed: ${err instanceof Error ? err.message : String(err)}>`;
  }
}

async function safeReadPromptMd(cwd: string): Promise<string | null> {
  try {
    return await readFile(join(cwd, '.noetic', 'PROMPT.md'), 'utf8');
  } catch {
    return null;
  }
}

//#endregion

//#region Result handlers

interface HandleResultArgs {
  deps: AutopilotDeps;
  feature: MissionFeatureRecord;
  result: ValidatorRunResult;
}

function handlePassResult(args: HandleResultArgs): void {
  markFeaturePassed(args.deps.cwd, args.feature.id);
}

function handleFailResult(args: HandleResultArgs): void {
  let fixFeatureId: string | null = null;
  try {
    const fix = createGeneratedFixFeature(args.deps.cwd, {
      sourceFeatureId: args.feature.id,
      validatorRunId: args.result.runId,
    });
    fixFeatureId = fix.id;
  } catch (err) {
    if (err instanceof BudgetExhaustedError) {
      markFeatureBlocked(
        args.deps.cwd,
        args.feature.id,
        `Implementation retry budget exhausted (${err.attemptCount}/${err.budget}).`,
      );
      return;
    }
    throw err;
  }
  if (fixFeatureId === null) {
    return;
  }
  triageFeature(args.deps.cwd, fixFeatureId);
}

function handleBlockedResult(args: HandleResultArgs): void {
  markFeatureBlocked(
    args.deps.cwd,
    args.feature.id,
    args.result.blockedReason ?? args.result.summary,
  );
}

function handleErrorResult(args: HandleResultArgs): void {
  log.warn(
    `[missions.validator] feature ${args.feature.id} validator errored: ${args.result.summary}`,
  );
}

const resultHandlers: Record<ValidatorRunResult['status'], (args: HandleResultArgs) => void> = {
  pass: handlePassResult,
  fail: handleFailResult,
  blocked: handleBlockedResult,
  error: handleErrorResult,
};

//#endregion

//#region Tick

async function reapStaleRunningRuns(deps: AutopilotDeps): Promise<void> {
  const runningRuns = loadRunningValidatorRuns(deps.cwd);
  for (const run of runningRuns) {
    if (run.pid === null) {
      continue;
    }
    if (deps.signaller.isAlive(run.pid)) {
      continue;
    }
    updateValidatorRun(deps.cwd, run.id, {
      status: 'error',
      completedAt: nowIso(),
      resultJson: JSON.stringify({
        error: `pid ${run.pid} no longer alive (reaped by validator job)`,
      }),
    });
  }
}

interface RunFeatureValidationArgs {
  deps: AutopilotDeps;
  feature: MissionFeatureRecord;
}

async function runFeatureValidation(args: RunFeatureValidationArgs): Promise<void> {
  const { deps, feature } = args;
  if (feature.taskId === null) {
    log.warn(
      `[missions.validator] feature ${feature.id} is validating but has no linked task; skipping`,
    );
    return;
  }
  if (hasInflightRun(deps.cwd, feature.id)) {
    return;
  }
  const task = loadTaskForFeature(deps.cwd, feature.taskId);
  if (task === null) {
    log.warn(
      `[missions.validator] feature ${feature.id} references missing task ${feature.taskId}`,
    );
    return;
  }
  const assertions = loadAssertionsForFeature(deps.cwd, feature);
  const taskContextBlob = await buildTaskContextBlob({
    task,
  });
  const parentCtx: Context = deps.missionHarness.createContext();
  const result = await runValidator({
    cwd: deps.cwd,
    feature,
    assertions,
    taskContextBlob,
    harness: deps.missionHarness,
    parentCtx,
    model: deps.model,
  });
  const handler = resultHandlers[result.status];
  handler({
    deps,
    feature,
    result,
  });
}

async function runValidatorTick(deps: AutopilotDeps): Promise<void> {
  await reapStaleRunningRuns(deps);
  const features = loadValidatingFeatures(deps.cwd);
  for (const feature of features) {
    try {
      await runFeatureValidation({
        deps,
        feature,
      });
    } catch (err) {
      log.warn(
        `[missions.validator] feature ${feature.id} validation failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

//#endregion

//#region Public API

/** @public Daemon job: scan validating features, run the validator, dispatch on result. */
export function missionsValidatorPollJob(deps: AutopilotDeps): JobDefinition {
  return {
    id: 'missions.validator.poll',
    intervalMs: VALIDATOR_TICK_INTERVAL_MS,
    runOnStart: true,
    run: async () => {
      await runValidatorTick(deps);
    },
  };
}

/** @public Test seam: drive a single validator-job tick deterministically. */
export async function _testRunValidatorTick(deps: AutopilotDeps): Promise<void> {
  await runValidatorTick(deps);
}

//#endregion
