import { eq } from 'drizzle-orm';

import type { JobDefinition } from '../../../../daemon-runtime/jobs.js';
import * as log from '../../../../util/log.js';
import type { MissionFeatureRecord, MissionValidatorRunRecord } from '../db/schema.js';
import { missionFeatures, missionValidatorRuns, tasks } from '../db/schema.js';
import type { AutopilotDeps } from './autopilot.js';
import { markFeatureBlocked, updateValidatorRun, withMissionsDb } from './store.js';

//#region Constants

const HEALTH_TICK_INTERVAL_MS = 5 * 60_000;

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

function loadFeaturesByLoopState(
  cwd: string,
  loopState: MissionFeatureRecord['loopState'],
): MissionFeatureRecord[] {
  return withMissionsDb(cwd, ({ db }) =>
    db.select().from(missionFeatures).where(eq(missionFeatures.loopState, loopState)).all(),
  );
}

function taskExists(cwd: string, taskId: string): boolean {
  return withMissionsDb(cwd, ({ db }) => {
    const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    return row !== undefined;
  });
}

interface RunIdentityArgs {
  deps: AutopilotDeps;
  run: MissionValidatorRunRecord;
}

function isRunIdentityValid(args: RunIdentityArgs): boolean {
  const { deps, run } = args;
  if (run.pid === null) {
    return true;
  }
  if (!deps.signaller.isAlive(run.pid)) {
    return false;
  }
  if (run.pidStarttime === null) {
    return true;
  }
  const current = deps.signaller.startTime(run.pid);
  if (current === null) {
    return false;
  }
  return current === run.pidStarttime;
}

//#endregion

//#region Tick steps

function reapStaleValidatorRuns(deps: AutopilotDeps): number {
  const running = loadRunningValidatorRuns(deps.cwd);
  let reaped = 0;
  for (const run of running) {
    if (
      isRunIdentityValid({
        deps,
        run,
      })
    ) {
      continue;
    }
    updateValidatorRun(deps.cwd, run.id, {
      status: 'error',
      completedAt: nowIso(),
      resultJson: JSON.stringify({
        error: `pid ${run.pid ?? '<none>'} no longer alive (reaped by health job)`,
      }),
    });
    reaped += 1;
  }
  return reaped;
}

function reconcileFeatureLinkageDrift(deps: AutopilotDeps): number {
  let reconciled = 0;
  const states: Array<MissionFeatureRecord['loopState']> = [
    'implementing',
    'validating',
  ];
  for (const state of states) {
    const features = loadFeaturesByLoopState(deps.cwd, state);
    for (const feature of features) {
      if (feature.taskId === null) {
        continue;
      }
      if (taskExists(deps.cwd, feature.taskId)) {
        continue;
      }
      markFeatureBlocked(
        deps.cwd,
        feature.id,
        `Linked task ${feature.taskId} was deleted while feature was ${state}.`,
      );
      reconciled += 1;
    }
  }
  return reconciled;
}

async function runHealthTick(deps: AutopilotDeps): Promise<void> {
  const reapedRuns = reapStaleValidatorRuns(deps);
  const reconciledFeatures = reconcileFeatureLinkageDrift(deps);
  if (reapedRuns > 0 || reconciledFeatures > 0) {
    log.warn(
      `[missions.health] reaped ${reapedRuns} stale validator run(s); reconciled ${reconciledFeatures} feature(s) with deleted tasks`,
    );
  }
}

//#endregion

//#region Public API

/** @public Daemon job: sweep stale validator runs and reconcile feature ↔ task drift. */
export function missionsHealthReconcileJob(deps: AutopilotDeps): JobDefinition {
  return {
    id: 'missions.health.reconcile',
    intervalMs: HEALTH_TICK_INTERVAL_MS,
    runOnStart: false,
    run: async () => {
      await runHealthTick(deps);
    },
  };
}

/** @public Test seam: drive a single health-job tick deterministically. */
export async function _testRunHealthTick(deps: AutopilotDeps): Promise<void> {
  await runHealthTick(deps);
}

//#endregion
