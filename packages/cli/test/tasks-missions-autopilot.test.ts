import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentHarness, createLocalFsAdapter } from '@noetic/core';
import { eq } from 'drizzle-orm';

import type { Signaller } from '../src/commands/builtins/tasks/agent-ci-control.js';
import { openTasksDatabaseAtPath } from '../src/commands/builtins/tasks/db/index.js';
import {
  missionFeatures,
  missions,
  slices,
  tasks,
} from '../src/commands/builtins/tasks/db/schema.js';
import type { AutopilotDeps } from '../src/commands/builtins/tasks/missions/autopilot.js';
import { runAutopilotTick } from '../src/commands/builtins/tasks/missions/autopilot.js';
import {
  addFeature,
  addMilestone,
  addSlice,
  createMission,
  linkFeatureToTask,
  markFeatureBlocked,
  markFeaturePassed,
  resetOpenMissionsDatabase,
  setOpenMissionsDatabase,
  triageSlice,
  updateMission,
} from '../src/commands/builtins/tasks/missions/store.js';

//#region Fixtures

let cwd: string;
let dbPath: string;

function freshCwd(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function openTestDb(): ReturnType<typeof openTasksDatabaseAtPath> {
  return openTasksDatabaseAtPath(dbPath);
}

const mockSignaller: Signaller = {
  kill: () => undefined,
  isAlive: () => true,
  startTime: () => null,
};

const mockFs = createLocalFsAdapter();

function buildDeps(): AutopilotDeps {
  // The pure-logic autopilot tick never invokes the harness or fs directly —
  // those deps only matter when the validator job spins up real LLM calls.
  // A real (but unused) harness keeps types honest without `as` casts.
  const missionHarness = new AgentHarness({
    name: 'autopilot-test-harness',
    params: {},
  });
  return {
    cwd,
    fs: mockFs,
    signaller: mockSignaller,
    missionHarness,
    model: 'mock/model',
  };
}

interface SeededMission {
  missionId: string;
  milestoneId: string;
  sliceId: string;
  secondSliceId: string;
  featureId: string;
}

function seedMissionWithTwoSlices(): SeededMission {
  const mission = createMission(cwd, {
    title: 'Mission with two slices',
  });
  updateMission(cwd, mission.id, {
    autopilotEnabled: true,
    status: 'active',
  });
  const milestone = addMilestone(cwd, {
    missionId: mission.id,
    title: 'M1',
    verification: 'mv',
    orderIndex: 0,
  });
  const sliceA = addSlice(cwd, {
    milestoneId: milestone.id,
    title: 'Slice A',
    verification: 'sv-a',
    orderIndex: 0,
  });
  const sliceB = addSlice(cwd, {
    milestoneId: milestone.id,
    title: 'Slice B',
    verification: 'sv-b',
    orderIndex: 1,
  });
  const feature = addFeature(cwd, {
    sliceId: sliceA.id,
    title: 'F1',
    acceptanceCriteria: [
      'a',
    ],
    orderIndex: 0,
  });
  addFeature(cwd, {
    sliceId: sliceB.id,
    title: 'F-B',
    acceptanceCriteria: [
      'b',
    ],
    orderIndex: 0,
  });
  return {
    missionId: mission.id,
    milestoneId: milestone.id,
    sliceId: sliceA.id,
    secondSliceId: sliceB.id,
    featureId: feature.id,
  };
}

function seedMissionSingleSlice(): SeededMission {
  const mission = createMission(cwd, {
    title: 'Single slice mission',
  });
  updateMission(cwd, mission.id, {
    autopilotEnabled: true,
    status: 'active',
  });
  const milestone = addMilestone(cwd, {
    missionId: mission.id,
    title: 'M1',
    verification: 'mv',
    orderIndex: 0,
  });
  const slice = addSlice(cwd, {
    milestoneId: milestone.id,
    title: 'Only slice',
    verification: 'sv',
    orderIndex: 0,
  });
  const feature = addFeature(cwd, {
    sliceId: slice.id,
    title: 'F-only',
    acceptanceCriteria: [
      'a',
    ],
    orderIndex: 0,
  });
  return {
    missionId: mission.id,
    milestoneId: milestone.id,
    sliceId: slice.id,
    secondSliceId: '',
    featureId: feature.id,
  };
}

function seedTaskRow(taskId: string, status: 'active' | 'merged' = 'active'): void {
  const opened = openTestDb();
  const now = new Date().toISOString();
  try {
    opened.db
      .insert(tasks)
      .values({
        id: taskId,
        projectRoot: cwd,
        worktreePath: `/tmp/${taskId}`,
        title: 'task',
        branch: null,
        headSha: null,
        reviewStatus: 'not_started',
        status,
        source: 'git-worktree',
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      })
      .run();
  } finally {
    opened.close();
  }
}

function setSliceStatus(sliceId: string, status: 'pending' | 'active' | 'complete'): void {
  const opened = openTestDb();
  const now = new Date().toISOString();
  try {
    opened.db
      .update(slices)
      .set({
        status,
        updatedAt: now,
      })
      .where(eq(slices.id, sliceId))
      .run();
  } finally {
    opened.close();
  }
}

function setTaskStatus(taskId: string, status: 'active' | 'merged'): void {
  const opened = openTestDb();
  const now = new Date().toISOString();
  try {
    opened.db
      .update(tasks)
      .set({
        status,
        updatedAt: now,
      })
      .where(eq(tasks.id, taskId))
      .run();
  } finally {
    opened.close();
  }
}

function getMissionRow(missionId: string): {
  status: string;
  autopilotState: string;
  autopilotEnabled: boolean;
} {
  const opened = openTestDb();
  try {
    const row = opened.db.select().from(missions).where(eq(missions.id, missionId)).get();
    if (!row) {
      throw new Error('mission row missing');
    }
    return {
      status: row.status,
      autopilotState: row.autopilotState,
      autopilotEnabled: row.autopilotEnabled,
    };
  } finally {
    opened.close();
  }
}

function getSliceStatus(sliceId: string): string {
  const opened = openTestDb();
  try {
    const row = opened.db.select().from(slices).where(eq(slices.id, sliceId)).get();
    return row?.status ?? '<missing>';
  } finally {
    opened.close();
  }
}

function getFeatureLoopState(featureId: string): string {
  const opened = openTestDb();
  try {
    const row = opened.db
      .select()
      .from(missionFeatures)
      .where(eq(missionFeatures.id, featureId))
      .get();
    return row?.loopState ?? '<missing>';
  } finally {
    opened.close();
  }
}

beforeEach(() => {
  cwd = freshCwd('noetic-missions-autopilot-');
  dbPath = join(cwd, 'tasks.sqlite');
  setOpenMissionsDatabase(() => openTasksDatabaseAtPath(dbPath));
});

afterEach(() => {
  resetOpenMissionsDatabase();
});

//#endregion

//#region runAutopilotTick — state transitions

describe('runAutopilotTick — mission state machine', () => {
  test('inactive → watching: a planning mission with autopilot on and pending work transitions out of inactive', async () => {
    // Seed a mission with at least one pending slice so the tick has work to
    // do (a mission with no milestones immediately advances to complete).
    const seed = seedMissionWithTwoSlices();
    const report = await runAutopilotTick(buildDeps());
    expect(report.missionsScanned).toBe(1);
    const after = getMissionRow(seed.missionId);
    expect(after.autopilotState).not.toBe('inactive');
  });

  test('watching → activating → watching: with no active slice but a pending one, activates and triages', async () => {
    const seed = seedMissionWithTwoSlices();

    const report = await runAutopilotTick(buildDeps());

    expect(report.slicesActivated).toBe(1);
    expect(report.featuresTriaged).toBe(1);
    expect(getSliceStatus(seed.sliceId)).toBe('active');
    const mission = getMissionRow(seed.missionId);
    expect(mission.autopilotState).toBe('watching');
  });

  test('implementing feature with merged task transitions to validating on the next tick', async () => {
    const seed = seedMissionWithTwoSlices();
    setSliceStatus(seed.sliceId, 'active');
    seedTaskRow('task-impl-1');
    linkFeatureToTask(cwd, seed.featureId, 'task-impl-1');
    setTaskStatus('task-impl-1', 'merged');

    const report = await runAutopilotTick(buildDeps());

    expect(report.validatingTransitions).toBe(1);
    expect(getFeatureLoopState(seed.featureId)).toBe('validating');
  });

  test('implementing feature with non-merged task does not transition', async () => {
    const seed = seedMissionWithTwoSlices();
    setSliceStatus(seed.sliceId, 'active');
    seedTaskRow('task-impl-2');
    linkFeatureToTask(cwd, seed.featureId, 'task-impl-2');

    const report = await runAutopilotTick(buildDeps());

    expect(report.validatingTransitions).toBe(0);
    expect(getFeatureLoopState(seed.featureId)).toBe('implementing');
  });

  test('all features passed: marks slice complete and advances to next slice', async () => {
    const seed = seedMissionWithTwoSlices();
    setSliceStatus(seed.sliceId, 'active');
    markFeaturePassed(cwd, seed.featureId);

    const report = await runAutopilotTick(buildDeps());

    expect(report.slicesCompleted).toBe(1);
    expect(getSliceStatus(seed.sliceId)).toBe('complete');
    expect(getSliceStatus(seed.secondSliceId)).toBe('active');
    expect(report.slicesActivated).toBe(1);
    expect(report.featuresTriaged).toBe(1);
    const mission = getMissionRow(seed.missionId);
    expect(mission.autopilotState).toBe('watching');
  });

  test('completing → inactive: last slice complete marks mission complete and inactive', async () => {
    const seed = seedMissionSingleSlice();
    setSliceStatus(seed.sliceId, 'active');
    markFeaturePassed(cwd, seed.featureId);

    const report = await runAutopilotTick(buildDeps());

    expect(report.missionsCompleted).toBe(1);
    const mission = getMissionRow(seed.missionId);
    expect(mission.status).toBe('complete');
    expect(mission.autopilotState).toBe('inactive');
  });

  test('blocked feature with no other workable features keeps mission active and watching', async () => {
    const seed = seedMissionWithTwoSlices();
    setSliceStatus(seed.sliceId, 'active');
    markFeatureBlocked(cwd, seed.featureId, 'budget exhausted');

    const report = await runAutopilotTick(buildDeps());

    expect(report.missionsBlocked).toBe(1);
    expect(getSliceStatus(seed.sliceId)).toBe('active');
    const mission = getMissionRow(seed.missionId);
    expect(mission.autopilotState).toBe('watching');
  });

  test('mission with autopilot disabled is skipped entirely', async () => {
    const mission = createMission(cwd, {
      title: 'No autopilot',
    });
    const milestone = addMilestone(cwd, {
      missionId: mission.id,
      title: 'M',
      verification: 'v',
      orderIndex: 0,
    });
    addSlice(cwd, {
      milestoneId: milestone.id,
      title: 'S',
      verification: 'v',
      orderIndex: 0,
    });

    const report = await runAutopilotTick(buildDeps());

    expect(report.missionsScanned).toBe(0);
    const after = getMissionRow(mission.id);
    expect(after.autopilotState).toBe('inactive');
  });

  test('mission with status archived is skipped (only planning|active are scanned)', async () => {
    const mission = createMission(cwd, {
      title: 'Archived mission',
    });
    updateMission(cwd, mission.id, {
      autopilotEnabled: true,
      status: 'archived',
    });

    const report = await runAutopilotTick(buildDeps());

    expect(report.missionsScanned).toBe(0);
  });

  test('triageSlice (manual) followed by tick recognises in-flight implementing features', async () => {
    const seed = seedMissionWithTwoSlices();
    setSliceStatus(seed.sliceId, 'active');
    triageSlice(cwd, seed.sliceId);

    const report = await runAutopilotTick(buildDeps());

    expect(report.slicesCompleted).toBe(0);
    expect(getSliceStatus(seed.sliceId)).toBe('active');
    expect(getFeatureLoopState(seed.featureId)).toBe('implementing');
  });

  test('mission with no milestones at all advances directly to complete', async () => {
    const mission = createMission(cwd, {
      title: 'Empty mission',
    });
    updateMission(cwd, mission.id, {
      autopilotEnabled: true,
      status: 'active',
    });

    const report = await runAutopilotTick(buildDeps());

    expect(report.missionsCompleted).toBe(1);
    const after = getMissionRow(mission.id);
    expect(after.status).toBe('complete');
    expect(after.autopilotState).toBe('inactive');
  });
});

//#endregion

//#region report shape

describe('runAutopilotTick — report aggregation', () => {
  test('report counters increment cumulatively across multiple missions', async () => {
    const seedA = seedMissionWithTwoSlices();
    setSliceStatus(seedA.sliceId, 'active');
    markFeaturePassed(cwd, seedA.featureId);

    const seedB = seedMissionSingleSlice();
    setSliceStatus(seedB.sliceId, 'active');
    markFeaturePassed(cwd, seedB.featureId);

    const report = await runAutopilotTick(buildDeps());

    expect(report.missionsScanned).toBe(2);
    expect(report.slicesCompleted).toBe(2);
    expect(report.missionsCompleted).toBeGreaterThanOrEqual(1);
  });

  test('empty world yields a zero-valued report', async () => {
    const report = await runAutopilotTick(buildDeps());
    assert.deepEqual(
      {
        missionsScanned: report.missionsScanned,
        slicesActivated: report.slicesActivated,
        featuresTriaged: report.featuresTriaged,
      },
      {
        missionsScanned: 0,
        slicesActivated: 0,
        featuresTriaged: 0,
      },
    );
  });
});

//#endregion
