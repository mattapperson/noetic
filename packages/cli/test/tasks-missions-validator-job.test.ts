import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallModelRequest, LLMResponse } from '@noetic/core';
import { AgentHarness, createLocalFsAdapter } from '@noetic/core';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import type { Signaller } from '../src/commands/builtins/tasks/agent-ci-control.js';
import { openTasksDatabaseAtPath } from '../src/commands/builtins/tasks/db/index.js';
import {
  DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
  missionFeatures,
  missionFixFeatureLineage,
  tasks,
} from '../src/commands/builtins/tasks/db/schema.js';
import type { AutopilotDeps } from '../src/commands/builtins/tasks/missions/autopilot.js';
import {
  addAssertion,
  addFeature,
  addMilestone,
  addSlice,
  createMission,
  linkFeatureToTask,
  resetOpenMissionsDatabase,
  setOpenMissionsDatabase,
  updateMission,
} from '../src/commands/builtins/tasks/missions/store.js';
import type { ValidatorRunSchema } from '../src/commands/builtins/tasks/missions/validator.js';
import { _testRunValidatorTick } from '../src/commands/builtins/tasks/missions/validator-job.js';

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

interface SeededWorld {
  missionId: string;
  featureId: string;
  taskId: string;
  assertionId: string;
}

function seedFullWorld(): SeededWorld {
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
    description: 'do x',
    acceptanceCriteria: [
      'a',
    ],
    orderIndex: 0,
  });
  const assertion = addAssertion(cwd, {
    milestoneId: milestone.id,
    title: 'A1',
    assertion: 'must hold',
    orderIndex: 0,
    featureIds: [
      feature.id,
    ],
  });
  // Insert a task row directly so linkFeatureToTask succeeds.
  const opened = openTestDb();
  const now = new Date().toISOString();
  const taskId = `task-${feature.id}`;
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
        status: 'merged',
        source: 'git-worktree',
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      })
      .run();
  } finally {
    opened.close();
  }
  linkFeatureToTask(cwd, feature.id, taskId);
  // Manually transition the feature to 'validating' so the tick picks it up.
  setFeatureLoopState(feature.id, 'validating');
  return {
    missionId: mission.id,
    featureId: feature.id,
    taskId,
    assertionId: assertion.id,
  };
}

function setFeatureLoopState(
  featureId: string,
  loopState: 'implementing' | 'validating' | 'idle',
): void {
  const opened = openTestDb();
  const now = new Date().toISOString();
  try {
    opened.db
      .update(missionFeatures)
      .set({
        loopState,
        updatedAt: now,
      })
      .where(eq(missionFeatures.id, featureId))
      .run();
  } finally {
    opened.close();
  }
}

function setFeatureAttemptCount(featureId: string, count: number): void {
  const opened = openTestDb();
  const now = new Date().toISOString();
  try {
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

function getFeature(featureId: string): {
  loopState: string;
  status: string;
  blockedReason: string | null;
} {
  const opened = openTestDb();
  try {
    const row = opened.db
      .select()
      .from(missionFeatures)
      .where(eq(missionFeatures.id, featureId))
      .get();
    if (!row) {
      throw new Error('feature missing');
    }
    return {
      loopState: row.loopState,
      status: row.status,
      blockedReason: row.blockedReason,
    };
  } finally {
    opened.close();
  }
}

function passingPayload(assertionId: string): z.infer<typeof ValidatorRunSchema> {
  return {
    status: 'pass',
    assertions: [
      {
        assertionId,
        passed: true,
        message: 'ok',
      },
    ],
    summary: 'ok',
  };
}

function failingPayload(assertionId: string): z.infer<typeof ValidatorRunSchema> {
  return {
    status: 'fail',
    assertions: [
      {
        assertionId,
        passed: false,
        message: 'nope',
      },
    ],
    summary: 'failed',
  };
}

function blockedPayload(): z.infer<typeof ValidatorRunSchema> {
  return {
    status: 'blocked',
    assertions: [],
    summary: 'cannot evaluate',
    blockedReason: 'no diff',
  };
}

function makeAssistantMessage(text: string): LLMResponse['items'][number] {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 10)}`,
    status: 'completed',
    type: 'message',
    role: 'assistant',
    content: [
      {
        type: 'output_text',
        text,
      },
    ],
  };
}

function makeJsonResponse(payload: unknown): LLMResponse {
  return {
    items: [
      makeAssistantMessage(JSON.stringify(payload)),
    ],
    usage: {
      inputTokens: 10,
      outputTokens: 10,
    },
  };
}

function makeScriptedHarness(script: LLMResponse[]): AgentHarness {
  let index = 0;
  const callModel = async (_request: CallModelRequest): Promise<LLMResponse> => {
    if (index >= script.length) {
      throw new Error(`scripted harness exhausted after ${script.length} calls`);
    }
    return script[index++];
  };
  return new AgentHarness({
    name: 'validator-job-test-harness',
    params: {},
    _testCallModel: callModel,
  });
}

function buildDeps(harness: AgentHarness): AutopilotDeps {
  return {
    cwd,
    fs: createLocalFsAdapter(),
    signaller: mockSignaller,
    missionHarness: harness,
    model: 'mock/model',
  };
}

beforeEach(() => {
  cwd = freshCwd('noetic-missions-validator-job-');
  dbPath = join(cwd, 'tasks.sqlite');
  setOpenMissionsDatabase(() => openTasksDatabaseAtPath(dbPath));
});

afterEach(() => {
  resetOpenMissionsDatabase();
});

//#endregion

//#region Result handlers

describe('validator job — pass result', () => {
  test('pass result transitions feature to passed loopState', async () => {
    const seed = seedFullWorld();
    const harness = makeScriptedHarness([
      makeJsonResponse(passingPayload(seed.assertionId)),
    ]);

    await _testRunValidatorTick(buildDeps(harness));

    const after = getFeature(seed.featureId);
    expect(after.loopState).toBe('passed');
    expect(after.status).toBe('done');
  });
});

describe('validator job — fail result and budget boundary', () => {
  test('fail at attempt N-1 (count = budget-1, budget=3 → count=2): creates fix-feature and triages', async () => {
    const seed = seedFullWorld();
    setFeatureAttemptCount(seed.featureId, DEFAULT_IMPLEMENTATION_RETRY_BUDGET - 1);
    // Supply a fail response per ralph iteration (default budget = 3) so the
    // inner ralphWiggum exhausts its retry budget and surfaces the last
    // payload as `fail`.
    const harness = makeScriptedHarness([
      makeJsonResponse(failingPayload(seed.assertionId)),
      makeJsonResponse(failingPayload(seed.assertionId)),
      makeJsonResponse(failingPayload(seed.assertionId)),
      makeJsonResponse(failingPayload(seed.assertionId)),
    ]);

    await _testRunValidatorTick(buildDeps(harness));

    const opened = openTestDb();
    try {
      const lineage = opened.db
        .select()
        .from(missionFixFeatureLineage)
        .where(eq(missionFixFeatureLineage.sourceFeatureId, seed.featureId))
        .all();
      expect(lineage).toHaveLength(1);

      const allFeatures = opened.db.select().from(missionFeatures).all();
      const fixFeatures = allFeatures.filter((f) => f.generatedFromFeatureId === seed.featureId);
      expect(fixFeatures).toHaveLength(1);
      assert.ok(fixFeatures[0]);
      expect(fixFeatures[0].loopState).toBe('implementing');
    } finally {
      opened.close();
    }
  });

  test('fail at attempt N (count = budget): blocks the feature instead of creating a fix', async () => {
    const seed = seedFullWorld();
    setFeatureAttemptCount(seed.featureId, DEFAULT_IMPLEMENTATION_RETRY_BUDGET);
    const harness = makeScriptedHarness([
      makeJsonResponse(failingPayload(seed.assertionId)),
      makeJsonResponse(failingPayload(seed.assertionId)),
      makeJsonResponse(failingPayload(seed.assertionId)),
      makeJsonResponse(failingPayload(seed.assertionId)),
    ]);

    await _testRunValidatorTick(buildDeps(harness));

    const after = getFeature(seed.featureId);
    expect(after.loopState).toBe('blocked');
    expect(after.status).toBe('blocked');
    assert.ok(after.blockedReason);
    expect(after.blockedReason).toContain('budget exhausted');

    const opened = openTestDb();
    try {
      const lineage = opened.db
        .select()
        .from(missionFixFeatureLineage)
        .where(eq(missionFixFeatureLineage.sourceFeatureId, seed.featureId))
        .all();
      expect(lineage).toHaveLength(0);
    } finally {
      opened.close();
    }
  });
});

describe('validator job — blocked result', () => {
  test('blocked result transitions feature to blocked with the reason', async () => {
    const seed = seedFullWorld();
    // Blocked is non-pass; ralph re-runs up to budget. Supply enough
    // responses to cover all iterations.
    const harness = makeScriptedHarness([
      makeJsonResponse(blockedPayload()),
      makeJsonResponse(blockedPayload()),
      makeJsonResponse(blockedPayload()),
      makeJsonResponse(blockedPayload()),
    ]);

    await _testRunValidatorTick(buildDeps(harness));

    const after = getFeature(seed.featureId);
    expect(after.loopState).toBe('blocked');
    expect(after.blockedReason).toBe('no diff');
  });
});

describe('validator job — error result', () => {
  test('error result leaves feature in validating for retry on next tick', async () => {
    const seed = seedFullWorld();
    const harness = makeScriptedHarness([
      {
        items: [
          makeAssistantMessage('non-json output'),
        ],
        usage: {
          inputTokens: 5,
          outputTokens: 5,
        },
      },
    ]);

    await _testRunValidatorTick(buildDeps(harness));

    const after = getFeature(seed.featureId);
    expect(after.loopState).toBe('validating');
  });
});

describe('validator job — guard rails', () => {
  test('feature without a linked task is skipped', async () => {
    const seed = seedFullWorld();
    // Detach the task linkage to simulate a drift case the validator job must
    // handle gracefully.
    const opened = openTestDb();
    try {
      opened.db
        .update(missionFeatures)
        .set({
          taskId: null,
        })
        .where(eq(missionFeatures.id, seed.featureId))
        .run();
    } finally {
      opened.close();
    }
    const harness = makeScriptedHarness([]);

    await _testRunValidatorTick(buildDeps(harness));

    const after = getFeature(seed.featureId);
    // Still validating — the job logged a warning and moved on.
    expect(after.loopState).toBe('validating');
  });

  test('reaps a running validator run whose pid is no longer alive', async () => {
    const seed = seedFullWorld();
    const opened = openTestDb();
    try {
      opened.sqlite
        .prepare(
          `INSERT INTO mission_validator_runs (id, feature_id, started_at, status, pid)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('stale-run', seed.featureId, new Date().toISOString(), 'running', 99999);
    } finally {
      opened.close();
    }
    const deadSignaller: Signaller = {
      kill: () => undefined,
      isAlive: (pid) => pid !== 99999,
      startTime: () => null,
    };
    const harness = makeScriptedHarness([
      makeJsonResponse(passingPayload(seed.assertionId)),
    ]);
    const deps: AutopilotDeps = {
      cwd,
      fs: createLocalFsAdapter(),
      signaller: deadSignaller,
      missionHarness: harness,
      model: 'mock/model',
    };

    await _testRunValidatorTick(deps);

    const opened2 = openTestDb();
    try {
      const row = opened2.sqlite
        .prepare('SELECT status FROM mission_validator_runs WHERE id = ?')
        .get('stale-run');
      const RowSchema = z.object({
        status: z.string(),
      });
      const parsed = RowSchema.parse(row);
      expect(parsed.status).toBe('error');
    } finally {
      opened2.close();
    }
  });
});

//#endregion
