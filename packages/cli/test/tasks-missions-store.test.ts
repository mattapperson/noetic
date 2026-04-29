import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { openTasksDatabaseAtPath } from '../src/commands/builtins/tasks/db/index.js';
import type { MissionFeatureRecord } from '../src/commands/builtins/tasks/db/schema.js';
import {
  DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
  missionFeatures,
  missionFixFeatureLineage,
  missions,
  tasks,
} from '../src/commands/builtins/tasks/db/schema.js';
import type { MissionEventNameValue } from '../src/commands/builtins/tasks/missions/store.js';
import {
  activateSlice,
  addAssertion,
  addFeature,
  addMilestone,
  addSlice,
  BudgetExhaustedError,
  computeFeatureLoopState,
  computeMissionStatus,
  createGeneratedFixFeature,
  createMission,
  deleteMission,
  getFeatureLoopSnapshot,
  getMission,
  getMissionWithHierarchy,
  linkFeatureToTask,
  listMissions,
  MissionEventName,
  markFeatureBlocked,
  markFeaturePassed,
  missionEvents,
  persistMissionTree,
  recordValidatorRun,
  resetOpenMissionsDatabase,
  setOpenMissionsDatabase,
  triageFeature,
  triageSlice,
  updateMission,
  updateValidatorRun,
} from '../src/commands/builtins/tasks/missions/store.js';

interface CapturedEvent {
  name: MissionEventNameValue;
  payload: Record<string, unknown>;
}

function captureEvents(): {
  drain: () => CapturedEvent[];
  dispose: () => void;
} {
  const captured: CapturedEvent[] = [];
  const handlers = Object.values(MissionEventName).map((name) => {
    const handler = (payload: Record<string, unknown>): void => {
      captured.push({
        name,
        payload,
      });
    };
    missionEvents.on(name, handler);
    return {
      name,
      handler,
    };
  });
  return {
    drain: () => captured.slice(),
    dispose: () => {
      for (const { name, handler } of handlers) {
        missionEvents.off(name, handler);
      }
    },
  };
}

interface SeededMission {
  cwd: string;
  missionId: string;
  milestoneId: string;
  sliceId: string;
  feature: MissionFeatureRecord;
}

let cwd: string;
let dbPath: string;

function freshCwd(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function openTestDb(): ReturnType<typeof openTasksDatabaseAtPath> {
  return openTasksDatabaseAtPath(dbPath);
}

function seedMission(): SeededMission {
  const mission = createMission(cwd, {
    title: 'Seeded mission',
    description: 'desc',
  });
  const milestone = addMilestone(cwd, {
    missionId: mission.id,
    title: 'Milestone 1',
    verification: 'milestone passes',
    orderIndex: 0,
  });
  const slice = addSlice(cwd, {
    milestoneId: milestone.id,
    title: 'Slice 1',
    verification: 'slice passes',
    orderIndex: 0,
  });
  const feature = addFeature(cwd, {
    sliceId: slice.id,
    title: 'Feature 1',
    description: 'do the thing',
    acceptanceCriteria: [
      'criterion A',
      'criterion B',
    ],
    orderIndex: 0,
  });
  return {
    cwd,
    missionId: mission.id,
    milestoneId: milestone.id,
    sliceId: slice.id,
    feature,
  };
}

function seedTaskRow(taskId: string): void {
  const opened = openTestDb();
  const now = new Date().toISOString();
  try {
    opened.db
      .insert(tasks)
      .values({
        id: taskId,
        projectRoot: cwd,
        worktreePath: `/repo-${taskId}`,
        title: 'task title',
        branch: `branch-${taskId}`,
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

beforeEach(() => {
  cwd = freshCwd('noetic-missions-store-');
  dbPath = join(cwd, 'tasks.sqlite');
  setOpenMissionsDatabase(() => openTasksDatabaseAtPath(dbPath));
});

afterEach(() => {
  missionEvents.removeAllListeners();
  resetOpenMissionsDatabase();
});

describe('missions store CRUD', () => {
  test('createMission writes a row and emits mission.created', () => {
    const cap = captureEvents();
    try {
      const row = createMission(cwd, {
        title: 'New mission',
      });
      expect(row.id).toBeTruthy();
      expect(row.title).toBe('New mission');
      expect(row.status).toBe('planning');
      expect(row.autopilotEnabled).toBe(false);

      const events = cap.drain();
      expect(events).toHaveLength(1);
      expect(events[0]?.name).toBe(MissionEventName.MissionCreated);
      expect(events[0]?.payload['missionId']).toBe(row.id);
    } finally {
      cap.dispose();
    }
  });

  test('getMission returns null for missing id and the row otherwise', () => {
    const created = createMission(cwd, {
      title: 'X',
    });
    expect(getMission(cwd, 'does-not-exist')).toBeNull();
    expect(getMission(cwd, created.id)?.title).toBe('X');
  });

  test('updateMission emits statusChanged only when status differs', () => {
    const created = createMission(cwd, {
      title: 'M',
    });
    const cap = captureEvents();
    try {
      updateMission(cwd, created.id, {
        title: 'renamed',
      });
      let events = cap.drain();
      expect(events.find((e) => e.name === MissionEventName.MissionStatusChanged)).toBeUndefined();

      updateMission(cwd, created.id, {
        status: 'active',
      });
      events = cap.drain();
      const statusEvent = events.find((e) => e.name === MissionEventName.MissionStatusChanged);
      assert.ok(statusEvent);
      expect(statusEvent.payload['previousStatus']).toBe('planning');
      expect(statusEvent.payload['status']).toBe('active');
    } finally {
      cap.dispose();
    }
  });

  test('listMissions filters by status and orders by createdAt desc', () => {
    const a = createMission(cwd, {
      title: 'A',
    });
    const b = createMission(cwd, {
      title: 'B',
    });
    updateMission(cwd, b.id, {
      status: 'active',
    });
    const all = listMissions(cwd);
    expect(all.map((m) => m.id)).toContain(a.id);
    expect(all.map((m) => m.id)).toContain(b.id);

    const onlyActive = listMissions(cwd, {
      status: [
        'active',
      ],
    });
    expect(onlyActive).toHaveLength(1);
    expect(onlyActive[0]?.id).toBe(b.id);
  });

  test('deleteMission cascades to milestones, slices, features', () => {
    const seed = seedMission();
    deleteMission(cwd, seed.missionId);
    expect(getMission(cwd, seed.missionId)).toBeNull();
    const opened = openTestDb();
    try {
      const remainingFeatures = opened.db
        .select()
        .from(missionFeatures)
        .where(eq(missionFeatures.id, seed.feature.id))
        .all();
      expect(remainingFeatures).toHaveLength(0);
    } finally {
      opened.close();
    }
  });

  test('updateMission throws when mission does not exist', () => {
    expect(() =>
      updateMission(cwd, 'missing-id', {
        title: 'oops',
      }),
    ).toThrow(/not found/);
  });
});

describe('persistMissionTree', () => {
  test('persists a full tree transactionally and emits mission.created', () => {
    const cap = captureEvents();
    try {
      const mission = persistMissionTree(cwd, {
        title: 'Tree mission',
        description: 'top-level',
        milestones: [
          {
            title: 'M1',
            verification: 'M1 ok',
            slices: [
              {
                title: 'S1',
                verification: 'S1 ok',
                features: [
                  {
                    title: 'F1',
                    acceptanceCriteria: [
                      'a',
                    ],
                  },
                  {
                    title: 'F2',
                    acceptanceCriteria: [
                      'b',
                    ],
                  },
                ],
              },
            ],
            assertions: [
              {
                title: 'A1',
                assertion: 'must hold',
                featureIds: [
                  'F1',
                ],
              },
            ],
          },
        ],
      });

      const hierarchy = getMissionWithHierarchy(cwd, mission.id);
      assert.ok(hierarchy);
      expect(hierarchy.milestones).toHaveLength(1);
      expect(hierarchy.milestones[0]?.slices).toHaveLength(1);
      expect(hierarchy.milestones[0]?.slices[0]?.features).toHaveLength(2);
      expect(hierarchy.milestones[0]?.slices[0]?.features[0]?.acceptanceCriteriaParsed).toEqual([
        'a',
      ]);
      expect(hierarchy.milestones[0]?.assertions).toHaveLength(1);
      const expectedFeatureId = hierarchy.milestones[0]?.slices[0]?.features[0]?.id;
      expect(hierarchy.milestones[0]?.assertions[0]?.featureIdsParsed).toEqual([
        expectedFeatureId ?? '',
      ]);

      const events = cap.drain().filter((e) => e.name === MissionEventName.MissionCreated);
      expect(events).toHaveLength(1);
    } finally {
      cap.dispose();
    }
  });
});

describe('linkFeatureToTask', () => {
  test('updates both rows in one transaction and emits events', () => {
    const seed = seedMission();
    seedTaskRow('task-link-1');

    const cap = captureEvents();
    try {
      linkFeatureToTask(cwd, seed.feature.id, 'task-link-1');
      const featureRow = getFeatureLoopSnapshot(cwd, seed.feature.id).feature;
      expect(featureRow.taskId).toBe('task-link-1');
      expect(featureRow.loopState).toBe('implementing');
      expect(featureRow.status).toBe('triaged');
      expect(featureRow.implementationAttemptCount).toBe(1);

      const opened = openTestDb();
      try {
        const taskRow = opened.db.select().from(tasks).where(eq(tasks.id, 'task-link-1')).get();
        expect(taskRow?.missionId).toBe(seed.missionId);
        expect(taskRow?.sliceId).toBe(seed.sliceId);
        expect(taskRow?.featureId).toBe(seed.feature.id);
      } finally {
        opened.close();
      }

      const events = cap.drain();
      const linked = events.find((e) => e.name === MissionEventName.FeatureLinkedToTask);
      assert.ok(linked);
      expect(linked.payload['taskId']).toBe('task-link-1');
      const looped = events.find((e) => e.name === MissionEventName.FeatureLoopStateChanged);
      assert.ok(looped);
      expect(looped.payload['loopState']).toBe('implementing');
    } finally {
      cap.dispose();
    }
  });

  test('rolls back when task does not exist; feature row is unchanged', () => {
    const seed = seedMission();
    expect(() => linkFeatureToTask(cwd, seed.feature.id, 'no-such-task')).toThrow(/not found/);

    const featureAfter = getFeatureLoopSnapshot(cwd, seed.feature.id).feature;
    expect(featureAfter.taskId).toBeNull();
    expect(featureAfter.loopState).toBe('idle');
    expect(featureAfter.implementationAttemptCount).toBe(0);
  });

  test('throws when feature does not exist', () => {
    seedTaskRow('task-orphan');
    expect(() => linkFeatureToTask(cwd, 'no-feature', 'task-orphan')).toThrow(/Feature/);
  });

  test('does not increment attempt count when re-linking from non-idle state', () => {
    const seed = seedMission();
    seedTaskRow('task-relink-1');
    seedTaskRow('task-relink-2');
    linkFeatureToTask(cwd, seed.feature.id, 'task-relink-1');
    linkFeatureToTask(cwd, seed.feature.id, 'task-relink-2');
    const snapshot = getFeatureLoopSnapshot(cwd, seed.feature.id);
    expect(snapshot.feature.taskId).toBe('task-relink-2');
    expect(snapshot.feature.implementationAttemptCount).toBe(1);
  });
});

describe('triage', () => {
  test('triageSlice creates one task per feature and emits per-feature events', () => {
    const seed = seedMission();
    addFeature(cwd, {
      sliceId: seed.sliceId,
      title: 'Feature 2',
      acceptanceCriteria: [
        'c',
      ],
      orderIndex: 1,
    });

    const cap = captureEvents();
    try {
      const result = triageSlice(cwd, seed.sliceId);
      expect(result.created).toHaveLength(2);
      expect(result.linkedFeatureIds).toHaveLength(2);
      for (const task of result.created) {
        expect(task.missionId).toBe(seed.missionId);
        expect(task.sliceId).toBe(seed.sliceId);
        expect(task.featureId).toBeTruthy();
      }

      const events = cap.drain();
      expect(events.filter((e) => e.name === MissionEventName.FeatureLinkedToTask)).toHaveLength(2);
      expect(
        events.filter((e) => e.name === MissionEventName.FeatureLoopStateChanged),
      ).toHaveLength(2);
    } finally {
      cap.dispose();
    }
  });

  test('triageSlice skips already-linked features', () => {
    const seed = seedMission();
    seedTaskRow('preexisting');
    linkFeatureToTask(cwd, seed.feature.id, 'preexisting');
    const second = addFeature(cwd, {
      sliceId: seed.sliceId,
      title: 'Feature 2',
      acceptanceCriteria: [
        'c',
      ],
      orderIndex: 1,
    });

    const result = triageSlice(cwd, seed.sliceId);
    expect(result.linkedFeatureIds).toEqual([
      second.id,
    ]);
  });

  test('triageFeature throws when feature already linked', () => {
    const seed = seedMission();
    seedTaskRow('existing-task');
    linkFeatureToTask(cwd, seed.feature.id, 'existing-task');
    expect(() => triageFeature(cwd, seed.feature.id)).toThrow(/already linked/);
  });

  test('triageSlice throws on missing slice', () => {
    expect(() => triageSlice(cwd, 'no-slice')).toThrow(/Slice/);
  });
});

describe('activateSlice', () => {
  test('activates the slice and triggers triage when autopilot enabled', () => {
    const seed = seedMission();
    updateMission(cwd, seed.missionId, {
      autopilotEnabled: true,
    });

    activateSlice(cwd, seed.sliceId, {
      triage: true,
    });

    const hierarchy = getMissionWithHierarchy(cwd, seed.missionId);
    assert.ok(hierarchy);
    expect(hierarchy.milestones[0]?.slices[0]?.status).toBe('active');
    expect(hierarchy.milestones[0]?.slices[0]?.features[0]?.taskId).toBeTruthy();
  });

  test('does not triage when autopilot disabled even if triage requested', () => {
    const seed = seedMission();
    activateSlice(cwd, seed.sliceId, {
      triage: true,
    });
    const hierarchy = getMissionWithHierarchy(cwd, seed.missionId);
    assert.ok(hierarchy);
    expect(hierarchy.milestones[0]?.slices[0]?.status).toBe('active');
    expect(hierarchy.milestones[0]?.slices[0]?.features[0]?.taskId).toBeNull();
  });
});

describe('rollups', () => {
  test('computeMissionStatus reflects milestone roll-up', () => {
    const seed = seedMission();
    expect(computeMissionStatus(cwd, seed.missionId)).toBe('planning');
  });

  test('computeFeatureLoopState reads current row', () => {
    const seed = seedMission();
    expect(computeFeatureLoopState(cwd, seed.feature.id)).toBe('idle');
    markFeaturePassed(cwd, seed.feature.id);
    expect(computeFeatureLoopState(cwd, seed.feature.id)).toBe('passed');
  });

  test('getFeatureLoopSnapshot returns runs, lineage, and budget remaining', () => {
    const seed = seedMission();
    const run = recordValidatorRun(cwd, {
      featureId: seed.feature.id,
      status: 'pending',
    });
    const snapshot = getFeatureLoopSnapshot(cwd, seed.feature.id);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]?.id).toBe(run.id);
    expect(snapshot.retryBudgetRemaining).toBe(DEFAULT_IMPLEMENTATION_RETRY_BUDGET);
  });
});

describe('addAssertion', () => {
  test('serializes featureIds as JSON and emits no events', () => {
    const seed = seedMission();
    const cap = captureEvents();
    try {
      const a = addAssertion(cwd, {
        milestoneId: seed.milestoneId,
        title: 'A',
        assertion: 'must',
        orderIndex: 0,
        featureIds: [
          seed.feature.id,
        ],
      });
      expect(a.id).toBeTruthy();
      const hierarchy = getMissionWithHierarchy(cwd, seed.missionId);
      assert.ok(hierarchy);
      expect(hierarchy.milestones[0]?.assertions[0]?.featureIdsParsed).toEqual([
        seed.feature.id,
      ]);
      expect(cap.drain()).toHaveLength(0);
    } finally {
      cap.dispose();
    }
  });
});

describe('createGeneratedFixFeature', () => {
  test('happy path writes lineage and source feature transitions to needs_fix', () => {
    const seed = seedMission();
    seedTaskRow('task-fix-1');
    linkFeatureToTask(cwd, seed.feature.id, 'task-fix-1');
    const run = recordValidatorRun(cwd, {
      featureId: seed.feature.id,
      status: 'fail',
    });

    const cap = captureEvents();
    try {
      const fix = createGeneratedFixFeature(cwd, {
        sourceFeatureId: seed.feature.id,
        validatorRunId: run.id,
      });
      expect(fix.title).toBe('Fix: Feature 1');
      expect(fix.generatedFromFeatureId).toBe(seed.feature.id);
      expect(fix.generatedFromRunId).toBe(run.id);
      expect(fix.loopState).toBe('idle');

      const opened = openTestDb();
      try {
        const lineageRows = opened.db
          .select()
          .from(missionFixFeatureLineage)
          .where(eq(missionFixFeatureLineage.fixFeatureId, fix.id))
          .all();
        expect(lineageRows).toHaveLength(1);
        expect(lineageRows[0]?.sourceFeatureId).toBe(seed.feature.id);
      } finally {
        opened.close();
      }

      const sourceAfter = getFeatureLoopSnapshot(cwd, seed.feature.id).feature;
      expect(sourceAfter.loopState).toBe('needs_fix');
      expect(sourceAfter.implementationAttemptCount).toBe(2);

      const events = cap.drain();
      expect(events.find((e) => e.name === MissionEventName.FeatureFixGenerated)).toBeTruthy();
      expect(events.find((e) => e.name === MissionEventName.FeatureLoopStateChanged)).toBeTruthy();
    } finally {
      cap.dispose();
    }
  });

  test('boundary: at attempt N-1 (count = budget-2), succeeds and sets count to budget-1', () => {
    const seed = seedMission();
    setFeatureAttemptCount(seed.feature.id, DEFAULT_IMPLEMENTATION_RETRY_BUDGET - 2);
    const run = recordValidatorRun(cwd, {
      featureId: seed.feature.id,
      status: 'fail',
    });
    const fix = createGeneratedFixFeature(cwd, {
      sourceFeatureId: seed.feature.id,
      validatorRunId: run.id,
    });
    expect(fix.id).toBeTruthy();
    const after = getFeatureLoopSnapshot(cwd, seed.feature.id).feature;
    expect(after.implementationAttemptCount).toBe(DEFAULT_IMPLEMENTATION_RETRY_BUDGET - 1);
  });

  test('boundary: at count = budget-1, last allowed attempt; emits feature.budgetExhausted', () => {
    const seed = seedMission();
    setFeatureAttemptCount(seed.feature.id, DEFAULT_IMPLEMENTATION_RETRY_BUDGET - 1);
    const run = recordValidatorRun(cwd, {
      featureId: seed.feature.id,
      status: 'fail',
    });
    const cap = captureEvents();
    try {
      const fix = createGeneratedFixFeature(cwd, {
        sourceFeatureId: seed.feature.id,
        validatorRunId: run.id,
      });
      expect(fix.id).toBeTruthy();
      const exhaustedEvent = cap
        .drain()
        .find((e) => e.name === MissionEventName.FeatureBudgetExhausted);
      assert.ok(exhaustedEvent);
      expect(exhaustedEvent.payload['featureId']).toBe(seed.feature.id);
    } finally {
      cap.dispose();
    }
  });

  test('boundary: at count = budget (N+1), throws BudgetExhaustedError', () => {
    const seed = seedMission();
    setFeatureAttemptCount(seed.feature.id, DEFAULT_IMPLEMENTATION_RETRY_BUDGET);
    const run = recordValidatorRun(cwd, {
      featureId: seed.feature.id,
      status: 'fail',
    });
    let caught: unknown;
    try {
      createGeneratedFixFeature(cwd, {
        sourceFeatureId: seed.feature.id,
        validatorRunId: run.id,
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof BudgetExhaustedError);
    expect(caught.featureId).toBe(seed.feature.id);
    expect(caught.attemptCount).toBe(DEFAULT_IMPLEMENTATION_RETRY_BUDGET);
    expect(caught.budget).toBe(DEFAULT_IMPLEMENTATION_RETRY_BUDGET);
  });

  test('throws plain Error when validator run does not exist', () => {
    const seed = seedMission();
    expect(() =>
      createGeneratedFixFeature(cwd, {
        sourceFeatureId: seed.feature.id,
        validatorRunId: 'no-run',
      }),
    ).toThrow(/Validator run/);
  });

  test('throws plain Error when source feature does not exist', () => {
    const seed = seedMission();
    const run = recordValidatorRun(cwd, {
      featureId: seed.feature.id,
      status: 'fail',
    });
    expect(() =>
      createGeneratedFixFeature(cwd, {
        sourceFeatureId: 'missing-feature',
        validatorRunId: run.id,
      }),
    ).toThrow(/Source feature/);
  });
});

describe('validator runs', () => {
  test('recordValidatorRun increments validator attempt count and emits run recorded', () => {
    const seed = seedMission();
    const cap = captureEvents();
    try {
      const r = recordValidatorRun(cwd, {
        featureId: seed.feature.id,
        status: 'running',
      });
      expect(r.completedAt).toBeNull();
      const after = getFeatureLoopSnapshot(cwd, seed.feature.id).feature;
      expect(after.validatorAttemptCount).toBe(1);
      const events = cap.drain();
      expect(events.find((e) => e.name === MissionEventName.ValidatorRunRecorded)).toBeTruthy();
    } finally {
      cap.dispose();
    }
  });

  test('terminal status sets completedAt; updateValidatorRun emits another run recorded', () => {
    const seed = seedMission();
    const r = recordValidatorRun(cwd, {
      featureId: seed.feature.id,
      status: 'pass',
    });
    expect(r.completedAt).not.toBeNull();
    const cap = captureEvents();
    try {
      updateValidatorRun(cwd, r.id, {
        status: 'fail',
      });
      const events = cap.drain();
      expect(events.find((e) => e.name === MissionEventName.ValidatorRunRecorded)).toBeTruthy();
    } finally {
      cap.dispose();
    }
  });

  test('recordValidatorRun throws when feature missing', () => {
    expect(() =>
      recordValidatorRun(cwd, {
        featureId: 'missing',
        status: 'pending',
      }),
    ).toThrow(/Feature/);
  });

  test('updateValidatorRun throws when run missing', () => {
    expect(() =>
      updateValidatorRun(cwd, 'missing-run', {
        status: 'fail',
      }),
    ).toThrow(/Validator run/);
  });
});

describe('state transitions', () => {
  test('markFeaturePassed emits loopStateChanged once and is idempotent', () => {
    const seed = seedMission();
    const cap = captureEvents();
    try {
      markFeaturePassed(cwd, seed.feature.id);
      let events = cap.drain();
      expect(
        events.filter((e) => e.name === MissionEventName.FeatureLoopStateChanged),
      ).toHaveLength(1);
      markFeaturePassed(cwd, seed.feature.id);
      events = cap.drain();
      expect(
        events.filter((e) => e.name === MissionEventName.FeatureLoopStateChanged),
      ).toHaveLength(1);
    } finally {
      cap.dispose();
    }
  });

  test('markFeatureBlocked stores reason and transitions feature', () => {
    const seed = seedMission();
    markFeatureBlocked(cwd, seed.feature.id, 'budget exhausted');
    const after = getFeatureLoopSnapshot(cwd, seed.feature.id).feature;
    expect(after.loopState).toBe('blocked');
    expect(after.blockedReason).toBe('budget exhausted');
    expect(after.status).toBe('blocked');
  });

  test('markFeatureBlocked throws when feature missing', () => {
    expect(() => markFeatureBlocked(cwd, 'no-feature')).toThrow(/Feature/);
  });

  test('markFeaturePassed throws when feature missing', () => {
    expect(() => markFeaturePassed(cwd, 'no-feature')).toThrow(/Feature/);
  });
});

describe('mission row defaults', () => {
  test('persists autopilot fields with their defaults', () => {
    const created = createMission(cwd, {
      title: 'Defaults',
    });
    const opened = openTestDb();
    try {
      const row = opened.db.select().from(missions).where(eq(missions.id, created.id)).get();
      assert.ok(row);
      expect(row.autopilotEnabled).toBe(false);
      expect(row.autopilotState).toBe('inactive');
      expect(row.status).toBe('planning');
    } finally {
      opened.close();
    }
  });
});

function setFeatureAttemptCount(featureId: string, count: number): void {
  const opened = openTestDb();
  try {
    const now = new Date().toISOString();
    opened.db
      .update(missionFeatures)
      .set({
        implementationAttemptCount: count,
        updatedAt: now,
      })
      .where(eq(missionFeatures.id, featureId))
      .run();
  } finally {
    opened.close();
  }
}
