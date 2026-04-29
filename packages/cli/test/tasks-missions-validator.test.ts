import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CallModelRequest, LLMResponse } from '@noetic/core';
import { AgentHarness } from '@noetic/core';
import { z } from 'zod';

import { openTasksDatabaseAtPath } from '../src/commands/builtins/tasks/db/index.js';
import type {
  MissionContractAssertionRecord,
  MissionFeatureRecord,
} from '../src/commands/builtins/tasks/db/schema.js';
import {
  addAssertion,
  addFeature,
  addMilestone,
  addSlice,
  createMission,
  resetOpenMissionsDatabase,
  setOpenMissionsDatabase,
} from '../src/commands/builtins/tasks/missions/store.js';
import type { ValidatorRunSchema } from '../src/commands/builtins/tasks/missions/validator.js';
import { runValidator } from '../src/commands/builtins/tasks/missions/validator.js';

//#region Fixtures

let cwd: string;
let dbPath: string;

function freshCwd(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

interface SeededValidatorWorld {
  feature: MissionFeatureRecord;
  assertions: MissionContractAssertionRecord[];
}

function seedValidatorWorld(): SeededValidatorWorld {
  const mission = createMission(cwd, {
    title: 'Validator world',
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
    description: 'do the thing',
    acceptanceCriteria: [
      'criterion-A',
    ],
    orderIndex: 0,
  });
  const assertion = addAssertion(cwd, {
    milestoneId: milestone.id,
    title: 'A1',
    assertion: 'thing must be implemented',
    orderIndex: 0,
    featureIds: [
      feature.id,
    ],
  });
  return {
    feature,
    assertions: [
      assertion,
    ],
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

function passingPayload(assertionId: string): z.infer<typeof ValidatorRunSchema> {
  return {
    status: 'pass',
    assertions: [
      {
        assertionId,
        passed: true,
        message: 'all good',
      },
    ],
    summary: 'feature satisfies all assertions',
  };
}

function failingPayload(assertionId: string): z.infer<typeof ValidatorRunSchema> {
  return {
    status: 'fail',
    assertions: [
      {
        assertionId,
        passed: false,
        message: 'thing is not implemented',
        expected: 'present',
        actual: 'absent',
      },
    ],
    summary: 'feature does NOT satisfy assertion A1',
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
    name: 'validator-test-harness',
    params: {},
    _testCallModel: callModel,
  });
}

beforeEach(() => {
  cwd = freshCwd('noetic-missions-validator-');
  dbPath = join(cwd, 'tasks.sqlite');
  setOpenMissionsDatabase(() => openTasksDatabaseAtPath(dbPath));
});

afterEach(() => {
  resetOpenMissionsDatabase();
});

//#endregion

//#region runValidator — happy & failure paths

describe('runValidator', () => {
  test('returns status=pass when the validator emits a passing JSON envelope', async () => {
    const seeded = seedValidatorWorld();
    const harness = makeScriptedHarness([
      makeJsonResponse(passingPayload(seeded.assertions[0].id)),
    ]);
    const ctx = harness.createContext();

    const result = await runValidator({
      cwd,
      feature: seeded.feature,
      assertions: seeded.assertions,
      taskContextBlob: 'diff: + impl thing\nPROMPT: do the thing\nfinal: done',
      harness,
      parentCtx: ctx,
      model: 'mock/model',
      maxIterations: 1,
      innerMaxSteps: 2,
    });

    expect(result.status).toBe('pass');
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0].assertionId).toBe(seeded.assertions[0].id);
    expect(result.assertions[0].passed).toBe(true);
    expect(result.summary).toContain('satisfies');
    expect(typeof result.runId).toBe('string');
    expect(result.runId.length).toBeGreaterThan(0);
  });

  test('returns status=fail when validator emits a failing JSON envelope and budget exhausts', async () => {
    const seeded = seedValidatorWorld();
    // ralphWiggum with maxIterations=1 will run the inner once. The inner
    // ReAct loop runs the LLM until no tool calls. We supply one failing
    // JSON response (no tool calls → react exits → ralph verifies fail →
    // budget exhausted on first iteration since maxIterations is 1).
    const harness = makeScriptedHarness([
      makeJsonResponse(failingPayload(seeded.assertions[0].id)),
    ]);
    const ctx = harness.createContext();

    const result = await runValidator({
      cwd,
      feature: seeded.feature,
      assertions: seeded.assertions,
      taskContextBlob: 'diff: empty\nPROMPT: do the thing\nfinal: gave up',
      harness,
      parentCtx: ctx,
      model: 'mock/model',
      maxIterations: 1,
      innerMaxSteps: 2,
    });

    expect(result.status).toBe('fail');
    expect(result.assertions).toHaveLength(1);
    expect(result.assertions[0].passed).toBe(false);
    expect(result.assertions[0].message).toContain('not implemented');
    expect(result.summary).toContain('does NOT');
  });

  test('returns status=blocked when validator reports blocked status', async () => {
    const seeded = seedValidatorWorld();
    const blockedPayload: z.infer<typeof ValidatorRunSchema> = {
      status: 'blocked',
      assertions: [],
      summary: 'cannot evaluate',
      blockedReason: 'task context blob has no diff',
    };
    const harness = makeScriptedHarness([
      makeJsonResponse(blockedPayload),
    ]);
    const ctx = harness.createContext();

    const result = await runValidator({
      cwd,
      feature: seeded.feature,
      assertions: seeded.assertions,
      taskContextBlob: '',
      harness,
      parentCtx: ctx,
      model: 'mock/model',
      maxIterations: 1,
      innerMaxSteps: 2,
    });

    expect(result.status).toBe('blocked');
    expect(result.blockedReason).toBe('task context blob has no diff');
  });

  test('returns status=error when validator never emits parseable JSON', async () => {
    const seeded = seedValidatorWorld();
    const harness = makeScriptedHarness([
      {
        items: [
          makeAssistantMessage('I cannot answer this question.'),
        ],
        usage: {
          inputTokens: 5,
          outputTokens: 5,
        },
      },
    ]);
    const ctx = harness.createContext();

    const result = await runValidator({
      cwd,
      feature: seeded.feature,
      assertions: seeded.assertions,
      taskContextBlob: 'unparseable',
      harness,
      parentCtx: ctx,
      model: 'mock/model',
      maxIterations: 1,
      innerMaxSteps: 2,
    });

    expect(result.status).toBe('error');
    expect(result.assertions).toEqual([]);
    expect(result.summary).toContain('never produced a parseable');
  });

  test('records a mission_validator_runs row that ends in the final status', async () => {
    const seeded = seedValidatorWorld();
    const harness = makeScriptedHarness([
      makeJsonResponse(passingPayload(seeded.assertions[0].id)),
    ]);
    const ctx = harness.createContext();

    const result = await runValidator({
      cwd,
      feature: seeded.feature,
      assertions: seeded.assertions,
      taskContextBlob: 'pass blob',
      harness,
      parentCtx: ctx,
      model: 'mock/model',
      maxIterations: 1,
      innerMaxSteps: 2,
    });

    const opened = openTasksDatabaseAtPath(dbPath);
    try {
      const raw = opened.sqlite
        .prepare('SELECT status, completed_at FROM mission_validator_runs WHERE id = ?')
        .get(result.runId);
      const RowSchema = z.object({
        status: z.string(),
        completed_at: z.string(),
      });
      const row = RowSchema.parse(raw);
      expect(row.status).toBe('pass');
      expect(row.completed_at.length).toBeGreaterThan(0);
    } finally {
      opened.close();
    }
  });

  test('records status=error and re-emits the error message when timeout fires', async () => {
    const seeded = seedValidatorWorld();
    // Empty script — every LLM call throws "exhausted". The validator wraps
    // this in its catch block. By construction maxIterations=1 + zero-budget
    // script forces a synthetic error path.
    const harness = makeScriptedHarness([]);
    const ctx = harness.createContext();

    const result = await runValidator({
      cwd,
      feature: seeded.feature,
      assertions: seeded.assertions,
      taskContextBlob: 'whatever',
      harness,
      parentCtx: ctx,
      model: 'mock/model',
      maxIterations: 1,
      innerMaxSteps: 1,
    });

    expect(result.status).toBe('error');
    expect(result.summary.length).toBeGreaterThan(0);
  });
});

//#endregion
