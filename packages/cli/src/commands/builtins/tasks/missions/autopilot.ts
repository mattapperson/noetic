import type { AgentHarness, FsAdapter } from '@noetic/core';
import { and, asc, eq } from 'drizzle-orm';

import type { Signaller } from '../agent-ci-control.js';
import type {
  AutopilotState,
  FeatureLoopState,
  MissionFeatureRecord,
  MissionRecord,
  SliceRecord,
  TaskLifecycleStatus,
} from '../db/schema.js';
import { milestones, missionFeatures, missions, slices, tasks } from '../db/schema.js';
import { listMissions, triageSlice, updateMission, withMissionsDb } from './store.js';

//#region Types

/** @public Long-lived dependencies passed to autopilot/validator/health jobs. */
export interface AutopilotDeps {
  cwd: string;
  fs: FsAdapter;
  signaller: Signaller;
  /** Long-lived harness owned by the daemon (constructed once per process). */
  missionHarness: AgentHarness;
  model: string;
}

/** @public Aggregate counts produced by a single autopilot tick. */
export interface TickReport {
  missionsScanned: number;
  slicesActivated: number;
  featuresTriaged: number;
  validatingTransitions: number;
  slicesCompleted: number;
  missionsCompleted: number;
  missionsBlocked: number;
}

interface FeatureGroups {
  idle: MissionFeatureRecord[];
  implementing: MissionFeatureRecord[];
  validating: MissionFeatureRecord[];
  passed: MissionFeatureRecord[];
  needsFix: MissionFeatureRecord[];
  blocked: MissionFeatureRecord[];
}

interface MissionTickContext {
  mission: MissionRecord;
  report: TickReport;
}

interface SliceContext {
  mission: MissionRecord;
  slice: SliceRecord;
  features: MissionFeatureRecord[];
  groups: FeatureGroups;
  report: TickReport;
}

//#endregion

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

function emptyReport(): TickReport {
  return {
    missionsScanned: 0,
    slicesActivated: 0,
    featuresTriaged: 0,
    validatingTransitions: 0,
    slicesCompleted: 0,
    missionsCompleted: 0,
    missionsBlocked: 0,
  };
}

function groupFeaturesByLoopState(features: ReadonlyArray<MissionFeatureRecord>): FeatureGroups {
  const groups: FeatureGroups = {
    idle: [],
    implementing: [],
    validating: [],
    passed: [],
    needsFix: [],
    blocked: [],
  };
  for (const feature of features) {
    appendByLoopState(groups, feature);
  }
  return groups;
}

function appendByLoopState(groups: FeatureGroups, feature: MissionFeatureRecord): void {
  const state: FeatureLoopState = feature.loopState;
  if (state === 'idle') {
    groups.idle.push(feature);
    return;
  }
  if (state === 'implementing') {
    groups.implementing.push(feature);
    return;
  }
  if (state === 'validating') {
    groups.validating.push(feature);
    return;
  }
  if (state === 'passed') {
    groups.passed.push(feature);
    return;
  }
  if (state === 'needs_fix') {
    groups.needsFix.push(feature);
    return;
  }
  groups.blocked.push(feature);
}

function setMissionAutopilotState(cwd: string, mission: MissionRecord, next: AutopilotState): void {
  if (mission.autopilotState === next) {
    return;
  }
  updateMission(cwd, mission.id, {
    autopilotState: next,
    lastAutopilotActivityAt: nowIso(),
  });
}

function setMissionStatus(
  cwd: string,
  mission: MissionRecord,
  next: MissionRecord['status'],
): void {
  if (mission.status === next) {
    return;
  }
  updateMission(cwd, mission.id, {
    status: next,
    lastAutopilotActivityAt: nowIso(),
  });
}

interface ActiveSliceLookup {
  slice: SliceRecord | null;
  features: MissionFeatureRecord[];
  hasPendingSlice: boolean;
  nextPendingSlice: SliceRecord | null;
}

function loadActiveSliceForMission(cwd: string, missionId: string): ActiveSliceLookup {
  return withMissionsDb(cwd, ({ db }) => {
    const milestoneRows = db
      .select()
      .from(milestones)
      .where(eq(milestones.missionId, missionId))
      .orderBy(asc(milestones.orderIndex))
      .all();
    const milestoneIds = milestoneRows.map((row) => row.id);
    if (milestoneIds.length === 0) {
      return {
        slice: null,
        features: [],
        hasPendingSlice: false,
        nextPendingSlice: null,
      };
    }

    const sliceRows: SliceRecord[] = [];
    for (const milestoneId of milestoneIds) {
      const rows = db
        .select()
        .from(slices)
        .where(eq(slices.milestoneId, milestoneId))
        .orderBy(asc(slices.orderIndex))
        .all();
      sliceRows.push(...rows);
    }

    const activeSlice = sliceRows.find((row) => row.status === 'active') ?? null;
    const nextPendingSlice = sliceRows.find((row) => row.status === 'pending') ?? null;
    const hasPendingSlice = nextPendingSlice !== null;

    if (activeSlice === null) {
      return {
        slice: null,
        features: [],
        hasPendingSlice,
        nextPendingSlice,
      };
    }

    const features = db
      .select()
      .from(missionFeatures)
      .where(eq(missionFeatures.sliceId, activeSlice.id))
      .orderBy(asc(missionFeatures.orderIndex))
      .all();

    return {
      slice: activeSlice,
      features,
      hasPendingSlice,
      nextPendingSlice,
    };
  });
}

function loadTaskStatus(cwd: string, taskId: string): TaskLifecycleStatus | null {
  return withMissionsDb(cwd, ({ db }) => {
    const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    return row?.status ?? null;
  });
}

function transitionFeatureToValidating(cwd: string, featureId: string): void {
  withMissionsDb(cwd, ({ db }) => {
    db.update(missionFeatures)
      .set({
        loopState: 'validating',
        updatedAt: nowIso(),
      })
      .where(and(eq(missionFeatures.id, featureId), eq(missionFeatures.loopState, 'implementing')))
      .run();
  });
}

function markSliceComplete(cwd: string, sliceId: string): void {
  withMissionsDb(cwd, ({ db }) => {
    db.update(slices)
      .set({
        status: 'complete',
        updatedAt: nowIso(),
      })
      .where(eq(slices.id, sliceId))
      .run();
  });
}

function activatePendingSlice(cwd: string, sliceId: string): void {
  withMissionsDb(cwd, ({ db }) => {
    db.update(slices)
      .set({
        status: 'active',
        updatedAt: nowIso(),
      })
      .where(eq(slices.id, sliceId))
      .run();
  });
}

function refreshMission(cwd: string, missionId: string): MissionRecord | null {
  return withMissionsDb(cwd, ({ db }) => {
    const row = db.select().from(missions).where(eq(missions.id, missionId)).get();
    return row ?? null;
  });
}

//#endregion

//#region State machine

function transitionFeaturesToValidating(ctx: SliceContext): void {
  for (const feature of ctx.groups.implementing) {
    if (feature.taskId === null) {
      continue;
    }
    const status = loadTaskStatus(ctx.mission.id, feature.taskId);
    if (status !== 'merged') {
      continue;
    }
    transitionFeatureToValidating(ctx.mission.id, feature.id);
    ctx.report.validatingTransitions += 1;
  }
}

interface SliceCompletionDecision {
  kind: 'all_passed' | 'any_blocked' | 'in_progress' | 'empty';
}

function classifySliceCompletion(groups: FeatureGroups): SliceCompletionDecision {
  const total =
    groups.idle.length +
    groups.implementing.length +
    groups.validating.length +
    groups.passed.length +
    groups.needsFix.length +
    groups.blocked.length;
  if (total === 0) {
    return {
      kind: 'empty',
    };
  }
  const passedCount = groups.passed.length;
  if (passedCount === total) {
    return {
      kind: 'all_passed',
    };
  }
  const stillWorking =
    groups.idle.length +
    groups.implementing.length +
    groups.validating.length +
    groups.needsFix.length;
  if (stillWorking === 0 && groups.blocked.length > 0) {
    return {
      kind: 'any_blocked',
    };
  }
  return {
    kind: 'in_progress',
  };
}

function handleSliceAllPassed(deps: AutopilotDeps, ctx: SliceContext): void {
  markSliceComplete(deps.cwd, ctx.slice.id);
  ctx.report.slicesCompleted += 1;
  setMissionAutopilotState(deps.cwd, ctx.mission, 'activating');

  const refreshed = refreshMission(deps.cwd, ctx.mission.id) ?? ctx.mission;
  const lookup = loadActiveSliceForMission(deps.cwd, ctx.mission.id);
  if (!lookup.hasPendingSlice || lookup.nextPendingSlice === null) {
    setMissionAutopilotState(deps.cwd, refreshed, 'completing');
    setMissionStatus(deps.cwd, refreshed, 'complete');
    ctx.report.missionsCompleted += 1;
    const finalMission = refreshMission(deps.cwd, ctx.mission.id) ?? refreshed;
    setMissionAutopilotState(deps.cwd, finalMission, 'inactive');
    return;
  }

  activatePendingSlice(deps.cwd, lookup.nextPendingSlice.id);
  ctx.report.slicesActivated += 1;
  const triaged = triageSlice(deps.cwd, lookup.nextPendingSlice.id);
  ctx.report.featuresTriaged += triaged.linkedFeatureIds.length;

  const after = refreshMission(deps.cwd, ctx.mission.id) ?? refreshed;
  setMissionAutopilotState(deps.cwd, after, 'watching');
}

function handleSliceBlocked(deps: AutopilotDeps, ctx: SliceContext): void {
  setMissionAutopilotState(deps.cwd, ctx.mission, 'watching');
  ctx.report.missionsBlocked += 1;
}

function handleEmptySlice(deps: AutopilotDeps, ctx: SliceContext): void {
  // No features under the active slice — treat as already complete and
  // advance to the next slice (mirrors all-passed behavior).
  handleSliceAllPassed(deps, ctx);
}

const sliceHandlers: Record<
  SliceCompletionDecision['kind'],
  (deps: AutopilotDeps, ctx: SliceContext) => void
> = {
  all_passed: handleSliceAllPassed,
  any_blocked: handleSliceBlocked,
  in_progress: () => {
    /* nothing — keep watching */
  },
  empty: handleEmptySlice,
};

function loadFeaturesForSlice(cwd: string, sliceId: string): MissionFeatureRecord[] {
  return withMissionsDb(cwd, ({ db }) =>
    db
      .select()
      .from(missionFeatures)
      .where(eq(missionFeatures.sliceId, sliceId))
      .orderBy(asc(missionFeatures.orderIndex))
      .all(),
  );
}

interface TickActiveSliceArgs {
  deps: AutopilotDeps;
  ctx: MissionTickContext;
  slice: SliceRecord;
  features: MissionFeatureRecord[];
}

function tickMissionWithActiveSlice(args: TickActiveSliceArgs): void {
  const { deps, ctx, slice, features } = args;
  const groups = groupFeaturesByLoopState(features);
  const sliceCtx: SliceContext = {
    mission: ctx.mission,
    slice,
    features,
    groups,
    report: ctx.report,
  };
  transitionFeaturesToValidating(sliceCtx);
  const refreshedFeatures = loadFeaturesForSlice(deps.cwd, slice.id);
  const refreshedGroups = groupFeaturesByLoopState(refreshedFeatures);
  const decision = classifySliceCompletion(refreshedGroups);
  const handler = sliceHandlers[decision.kind];
  handler(deps, {
    ...sliceCtx,
    groups: refreshedGroups,
    features: refreshedFeatures,
  });
}

function tickMissionWithoutActiveSlice(
  deps: AutopilotDeps,
  ctx: MissionTickContext,
  nextPendingSlice: SliceRecord | null,
): void {
  if (nextPendingSlice === null) {
    setMissionAutopilotState(deps.cwd, ctx.mission, 'completing');
    setMissionStatus(deps.cwd, ctx.mission, 'complete');
    ctx.report.missionsCompleted += 1;
    const finalMission = refreshMission(deps.cwd, ctx.mission.id) ?? ctx.mission;
    setMissionAutopilotState(deps.cwd, finalMission, 'inactive');
    return;
  }
  setMissionAutopilotState(deps.cwd, ctx.mission, 'activating');
  activatePendingSlice(deps.cwd, nextPendingSlice.id);
  ctx.report.slicesActivated += 1;
  const triaged = triageSlice(deps.cwd, nextPendingSlice.id);
  ctx.report.featuresTriaged += triaged.linkedFeatureIds.length;
  const refreshed = refreshMission(deps.cwd, ctx.mission.id) ?? ctx.mission;
  setMissionAutopilotState(deps.cwd, refreshed, 'watching');
}

function tickOneMission(deps: AutopilotDeps, mission: MissionRecord, report: TickReport): void {
  if (mission.autopilotState === 'inactive') {
    setMissionAutopilotState(deps.cwd, mission, 'watching');
  }
  const refreshed = refreshMission(deps.cwd, mission.id) ?? mission;
  const ctx: MissionTickContext = {
    mission: refreshed,
    report,
  };
  const lookup = loadActiveSliceForMission(deps.cwd, refreshed.id);
  if (lookup.slice === null) {
    tickMissionWithoutActiveSlice(deps, ctx, lookup.nextPendingSlice);
    return;
  }
  tickMissionWithActiveSlice({
    deps,
    ctx,
    slice: lookup.slice,
    features: lookup.features,
  });
}

//#endregion

//#region Public API

/**
 * @public
 * Executes a single autopilot tick: scans every autopilot-enabled mission with
 * status `planning|active`, advances slice/mission state machines, and triages
 * newly-active slices. Pure logic — all I/O is mediated through the store.
 */
export async function runAutopilotTick(deps: AutopilotDeps): Promise<TickReport> {
  const report = emptyReport();
  const candidates = listMissions(deps.cwd, {
    status: [
      'planning',
      'active',
    ],
  }).filter((mission) => mission.autopilotEnabled === true);
  for (const mission of candidates) {
    report.missionsScanned += 1;
    tickOneMission(deps, mission, report);
  }
  return report;
}

//#endregion
