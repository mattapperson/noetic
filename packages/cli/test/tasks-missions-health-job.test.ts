import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentHarness, createLocalFsAdapter } from '@noetic/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Signaller } from '../src/commands/builtins/tasks/agent-ci-control.js';
import { openTasksDatabaseAtPath } from '../src/commands/builtins/tasks/db/index.js';
import {
  missionFeatures,
  missionValidatorRuns,
  tasks,
} from '../src/commands/builtins/tasks/db/schema.js';
import type { AutopilotDeps } from '../src/commands/builtins/tasks/missions/autopilot.js';
import { _testRunHealthTick } from '../src/commands/builtins/tasks/missions/health-job.js';
import {
  addFeature,
  addMilestone,
  addSlice,
  createMission,
  linkFeatureToTask,
  resetOpenMissionsDatabase,
  setOpenMissionsDatabase,
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

const aliveSignaller: Signaller = {
  kill: () => undefined,
  isAlive: () => true,
  startTime: () => null,
};

function makeMockHarness(): AgentHarness {
  return new AgentHarness({
    name: 'health-test-harness',
    params: {},
  });
}

function buildDeps(signaller: Signaller = aliveSignaller): AutopilotDeps {
  return {
    cwd,
    fs: createLocalFsAdapter(),
    signaller,
    missionHarness: makeMockHarness(),
    model: 'mock/model',
  };
}

interface SeededHealthWorld {
  missionId: string;
  featureId: string;
  taskId: string;
}

function seedHealthWorld(): SeededHealthWorld {
  const mission = createMission(cwd, {
    title: 'M',
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
    title: 'S1',
    verification: 'sv',
    orderIndex: 0,
  });
  const feature = addFeature(cwd, {
    sliceId: slice.id,
    title: 'F1',
    acceptanceCriteria: [
      'a',
    ],
    orderIndex: 0,
  });
  const taskId = `task-${feature.id}`;
  insertTask(taskId);
  linkFeatureToTask(cwd, feature.id, taskId);
  return {
    missionId: mission.id,
    featureId: feature.id,
    taskId,
  };
}

function insertTask(taskId: string): void {
  const opened = openTestDb();
  const now = new Date().toISOString();
  try {
    opened.db
      .insert(tasks)
      .values({
        id: taskId,
        projectRoot: cwd,
        worktreePath: `pending:${taskId}`,
        title: 'task',
        branch: null,
        headSha: null,
        reviewStatus: 'not_started',
        status: 'active',
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

function deleteTask(taskId: string): void {
  const opened = openTestDb();
  try {
    opened.db.delete(tasks).where(eq(tasks.id, taskId)).run();
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

function getValidatorRunStatus(runId: string): string {
  const opened = openTestDb();
  try {
    const row = opened.db
      .select()
      .from(missionValidatorRuns)
      .where(eq(missionValidatorRuns.id, runId))
      .get();
    return row?.status ?? '<missing>';
  } finally {
    opened.close();
  }
}

function insertRunningRun(args: {
  runId: string;
  featureId: string;
  pid: number | null;
  pidStarttime?: string | null;
}): void {
  const opened = openTestDb();
  const now = new Date().toISOString();
  try {
    opened.sqlite
      .prepare(
        `INSERT INTO mission_validator_runs (id, feature_id, started_at, status, pid, pid_starttime)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(args.runId, args.featureId, now, 'running', args.pid, args.pidStarttime ?? null);
  } finally {
    opened.close();
  }
}

beforeEach(() => {
  cwd = freshCwd('noetic-missions-health-');
  dbPath = join(cwd, 'tasks.sqlite');
  setOpenMissionsDatabase(() => openTasksDatabaseAtPath(dbPath));
});

afterEach(() => {
  resetOpenMissionsDatabase();
});

//#endregion

//#region health job — stale validator runs

describe('health job — stale validator runs', () => {
  test('reaps a running run whose pid is no longer alive', async () => {
    const seed = seedHealthWorld();
    insertRunningRun({
      runId: 'run-stale',
      featureId: seed.featureId,
      pid: 99999,
    });
    const deadSignaller: Signaller = {
      kill: () => undefined,
      isAlive: (pid) => pid !== 99999,
      startTime: () => null,
    };

    await _testRunHealthTick(buildDeps(deadSignaller));

    expect(getValidatorRunStatus('run-stale')).toBe('error');
  });

  test('keeps a running run whose pid is alive', async () => {
    const seed = seedHealthWorld();
    insertRunningRun({
      runId: 'run-live',
      featureId: seed.featureId,
      pid: 42,
    });

    await _testRunHealthTick(buildDeps());

    expect(getValidatorRunStatus('run-live')).toBe('running');
  });

  test('reaps a running run whose pid_starttime mismatches (PID reuse)', async () => {
    const seed = seedHealthWorld();
    insertRunningRun({
      runId: 'run-reused',
      featureId: seed.featureId,
      pid: 12345,
      pidStarttime: 'Mon Jan  1 12:00:00 2026',
    });
    // signaller reports the pid is alive but the start time differs (PID reused
    // by a different process since the run started).
    const reusedSignaller: Signaller = {
      kill: () => undefined,
      isAlive: () => true,
      startTime: () => 'Mon Apr 29 18:00:00 2026',
    };

    await _testRunHealthTick(buildDeps(reusedSignaller));

    expect(getValidatorRunStatus('run-reused')).toBe('error');
  });

  test('does not touch runs without a pid (in-process validator runs)', async () => {
    const seed = seedHealthWorld();
    insertRunningRun({
      runId: 'run-inproc',
      featureId: seed.featureId,
      pid: null,
    });

    await _testRunHealthTick(buildDeps());

    expect(getValidatorRunStatus('run-inproc')).toBe('running');
  });
});

//#endregion

//#region health job — feature ↔ task linkage drift

describe('health job — feature/task linkage drift', () => {
  test('blocks an implementing feature whose linked task was deleted', async () => {
    const seed = seedHealthWorld();
    deleteTask(seed.taskId);

    await _testRunHealthTick(buildDeps());

    expect(getFeatureLoopState(seed.featureId)).toBe('blocked');
  });

  test('blocks a validating feature whose linked task was deleted', async () => {
    const seed = seedHealthWorld();
    // Move feature into validating, then drop the task underneath it.
    const opened = openTestDb();
    try {
      opened.db
        .update(missionFeatures)
        .set({
          loopState: 'validating',
          updatedAt: new Date().toISOString(),
        })
        .where(eq(missionFeatures.id, seed.featureId))
        .run();
    } finally {
      opened.close();
    }
    deleteTask(seed.taskId);

    await _testRunHealthTick(buildDeps());

    expect(getFeatureLoopState(seed.featureId)).toBe('blocked');
  });

  test('leaves features alone when their linked task still exists', async () => {
    const seed = seedHealthWorld();

    await _testRunHealthTick(buildDeps());

    expect(getFeatureLoopState(seed.featureId)).toBe('implementing');
  });

  test('records the deleted-task reason on the blocked feature', async () => {
    const seed = seedHealthWorld();
    deleteTask(seed.taskId);

    await _testRunHealthTick(buildDeps());

    const opened = openTestDb();
    try {
      const row = opened.db
        .select()
        .from(missionFeatures)
        .where(eq(missionFeatures.id, seed.featureId))
        .get();
      const RowSchema = z.object({
        blockedReason: z.string().nullable(),
      });
      const parsed = RowSchema.parse(row);
      expect(parsed.blockedReason).not.toBeNull();
      expect(parsed.blockedReason ?? '').toContain(seed.taskId);
    } finally {
      opened.close();
    }
  });
});

//#endregion
