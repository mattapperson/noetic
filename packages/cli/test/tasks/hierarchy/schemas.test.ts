import { describe, expect, it } from 'bun:test';

import {
  AssertionSchema,
  AssertionStatus,
  DEFAULT_IMPLEMENTATION_RETRY_BUDGET,
  FeatureLoopState,
  FeatureSchema,
  FeatureStatus,
  FixLineageSchema,
  generateAssertionId,
  generateFeatureId,
  generateFixLineageId,
  generateInterviewSessionId,
  generateMilestoneId,
  generateSliceId,
  generateValidatorRunId,
  InterviewSessionSchema,
  InterviewSessionStatus,
  MilestoneSchema,
  MilestoneStatus,
  SliceSchema,
  SliceStatus,
  ValidatorRunSchema,
  ValidatorRunStatus,
} from '../../../src/tasks/runtime/hierarchy/schemas.js';

//#region ID generation

describe('hierarchy id generators', () => {
  it('produces correctly-prefixed unique ids', () => {
    expect(generateMilestoneId().startsWith('ML-')).toBe(true);
    expect(generateSliceId().startsWith('SL-')).toBe(true);
    expect(generateFeatureId().startsWith('F-')).toBe(true);
    expect(generateAssertionId().startsWith('A-')).toBe(true);
    expect(generateValidatorRunId().startsWith('V-')).toBe(true);
    expect(generateFixLineageId().startsWith('FX-')).toBe(true);
    expect(generateInterviewSessionId().startsWith('IV-')).toBe(true);

    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(generateFeatureId());
    }
    expect(ids.size).toBe(50);
  });
});

//#endregion

//#region Constants

describe('constants', () => {
  it('exposes DEFAULT_IMPLEMENTATION_RETRY_BUDGET', () => {
    expect(DEFAULT_IMPLEMENTATION_RETRY_BUDGET).toBe(3);
  });
});

//#endregion

//#region MilestoneSchema

describe('MilestoneSchema', () => {
  function valid() {
    return {
      id: generateMilestoneId(),
      taskId: 'T-abcdefghij',
      title: 'm1',
      description: null,
      verification: 'visual check',
      status: MilestoneStatus.Pending,
      orderIndex: 0,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };
  }

  it('round-trips a valid milestone', () => {
    const m = MilestoneSchema.parse(valid());
    expect(m.status).toBe(MilestoneStatus.Pending);
  });

  it('rejects an empty title', () => {
    expect(
      MilestoneSchema.safeParse({
        ...valid(),
        title: '',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown status', () => {
    expect(
      MilestoneSchema.safeParse({
        ...valid(),
        status: 'cancelled',
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed milestone id', () => {
    expect(
      MilestoneSchema.safeParse({
        ...valid(),
        id: 'mile-123',
      }).success,
    ).toBe(false);
  });

  it('rejects a negative orderIndex', () => {
    expect(
      MilestoneSchema.safeParse({
        ...valid(),
        orderIndex: -1,
      }).success,
    ).toBe(false);
  });
});

//#endregion

//#region SliceSchema

describe('SliceSchema', () => {
  it('rejects when milestoneId is missing the SL prefix entry', () => {
    expect(
      SliceSchema.safeParse({
        id: generateSliceId(),
        milestoneId: 'not-a-milestone',
        title: 'first slice',
        description: null,
        verification: 'tests pass',
        status: SliceStatus.Pending,
        orderIndex: 0,
        createdAt: '2026-04-30T00:00:00.000Z',
        updatedAt: '2026-04-30T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

//#endregion

//#region FeatureSchema

describe('FeatureSchema', () => {
  function valid() {
    return {
      id: generateFeatureId(),
      sliceId: generateSliceId(),
      title: 'f1',
      description: null,
      acceptanceCriteria: 'must pass tests',
      status: FeatureStatus.Defined,
      loopState: FeatureLoopState.Idle,
      implementationAttemptCount: 0,
      validatorAttemptCount: 0,
      taskId: null,
      generatedFromFeatureId: null,
      generatedFromRunId: null,
      blockedReason: null,
      orderIndex: 0,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    };
  }

  it('round-trips a defined feature', () => {
    const f = FeatureSchema.parse(valid());
    expect(f.loopState).toBe(FeatureLoopState.Idle);
  });

  it('accepts a fix-feature with lineage', () => {
    const f = FeatureSchema.parse({
      ...valid(),
      generatedFromFeatureId: generateFeatureId(),
      generatedFromRunId: generateValidatorRunId(),
      status: FeatureStatus.Triaged,
      loopState: FeatureLoopState.Implementing,
    });
    expect(f.generatedFromFeatureId).toBeTruthy();
  });

  it('rejects an unknown loopState', () => {
    expect(
      FeatureSchema.safeParse({
        ...valid(),
        loopState: 'paused',
      }).success,
    ).toBe(false);
  });

  it('rejects negative attempt counts', () => {
    expect(
      FeatureSchema.safeParse({
        ...valid(),
        implementationAttemptCount: -1,
      }).success,
    ).toBe(false);
  });
});

//#endregion

//#region AssertionSchema

describe('AssertionSchema', () => {
  it('accepts a fanned-out featureIds list', () => {
    const a = AssertionSchema.parse({
      id: generateAssertionId(),
      milestoneId: generateMilestoneId(),
      title: 'all green',
      assertion: 'all features in this milestone return 200',
      status: AssertionStatus.Pending,
      orderIndex: 0,
      featureIds: [
        generateFeatureId(),
        generateFeatureId(),
      ],
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });
    expect(a.featureIds).toHaveLength(2);
  });

  it('rejects featureIds with malformed entries', () => {
    expect(
      AssertionSchema.safeParse({
        id: generateAssertionId(),
        milestoneId: generateMilestoneId(),
        title: 'broken',
        assertion: 'x',
        status: AssertionStatus.Pending,
        orderIndex: 0,
        featureIds: [
          'not-a-feature',
        ],
        createdAt: '2026-04-30T00:00:00.000Z',
        updatedAt: '2026-04-30T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

//#endregion

//#region ValidatorRunSchema

describe('ValidatorRunSchema', () => {
  it('accepts a pending run', () => {
    const v = ValidatorRunSchema.parse({
      id: generateValidatorRunId(),
      featureId: generateFeatureId(),
      startedAt: '2026-04-30T00:00:00.000Z',
      completedAt: null,
      status: ValidatorRunStatus.Pending,
      result: null,
      pid: null,
      pidStarttime: null,
      pausedAt: null,
    });
    expect(v.status).toBe(ValidatorRunStatus.Pending);
  });

  it('accepts a passing run with result payload', () => {
    const v = ValidatorRunSchema.parse({
      id: generateValidatorRunId(),
      featureId: generateFeatureId(),
      startedAt: '2026-04-30T00:00:00.000Z',
      completedAt: '2026-04-30T00:01:00.000Z',
      status: ValidatorRunStatus.Pass,
      result: {
        suites: 3,
        passed: 3,
      },
      pid: 4242,
      pidStarttime: '12345',
      pausedAt: null,
    });
    expect(v.result).toEqual({
      suites: 3,
      passed: 3,
    });
  });
});

//#endregion

//#region FixLineageSchema

describe('FixLineageSchema', () => {
  it('round-trips a lineage entry', () => {
    const l = FixLineageSchema.parse({
      id: generateFixLineageId(),
      sourceFeatureId: generateFeatureId(),
      fixFeatureId: generateFeatureId(),
      validatorRunId: generateValidatorRunId(),
      createdAt: '2026-04-30T00:00:00.000Z',
    });
    expect(l.id.startsWith('FX-')).toBe(true);
  });

  it('rejects when source or fix features are malformed', () => {
    expect(
      FixLineageSchema.safeParse({
        id: generateFixLineageId(),
        sourceFeatureId: 'broken',
        fixFeatureId: generateFeatureId(),
        validatorRunId: generateValidatorRunId(),
        createdAt: '2026-04-30T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

//#endregion

//#region InterviewSessionSchema

describe('InterviewSessionSchema', () => {
  it('round-trips a session with state payload', () => {
    const s = InterviewSessionSchema.parse({
      id: generateInterviewSessionId(),
      taskId: 'T-abcdefghij',
      status: InterviewSessionStatus.Active,
      state: {
        questionsAsked: 2,
      },
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    });
    expect(s.status).toBe(InterviewSessionStatus.Active);
  });
});

//#endregion
