import { describe, expect, it } from 'bun:test';
import { hierarchyPaths } from '../../../src/commands/builtins/tasks/hierarchy/paths.js';
import type {
  Assertion,
  Feature,
  InterviewSession,
  Milestone,
  Slice,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import {
  AssertionStatus,
  FeatureLoopState,
  FeatureStatus,
  generateAssertionId,
  generateFeatureId,
  generateInterviewSessionId,
  generateMilestoneId,
  generateSliceId,
  InterviewSessionStatus,
  MilestoneStatus,
  SliceStatus,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import {
  clearTaskHierarchy,
  deleteAssertion,
  deleteFeature,
  deleteMilestone,
  deleteSlice,
  listAssertions,
  listFeatures,
  listInterviewSessions,
  listMilestones,
  listSlices,
  loadAssertion,
  loadFeature,
  loadInterviewSession,
  loadMilestone,
  loadSlice,
  saveAssertion,
  saveFeature,
  saveInterviewSession,
  saveMilestone,
  saveSlice,
} from '../../../src/commands/builtins/tasks/hierarchy/store.js';
import { makeStoreContext } from '../_helpers.js';

//#region Factories

const TASK_ID = 'T-abcdefghij';
const NOW = '2026-04-30T00:00:00.000Z';

function makeMilestone(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: generateMilestoneId(),
    taskId: TASK_ID,
    title: 'm',
    description: null,
    verification: 'tests pass',
    status: MilestoneStatus.Pending,
    orderIndex: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeSlice(milestoneId: string, overrides: Partial<Slice> = {}): Slice {
  return {
    id: generateSliceId(),
    milestoneId,
    title: 's',
    description: null,
    verification: 'tests pass',
    status: SliceStatus.Pending,
    orderIndex: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeFeature(sliceId: string, overrides: Partial<Feature> = {}): Feature {
  return {
    id: generateFeatureId(),
    sliceId,
    title: 'f',
    description: null,
    acceptanceCriteria: 'must work',
    status: FeatureStatus.Defined,
    loopState: FeatureLoopState.Idle,
    implementationAttemptCount: 0,
    validatorAttemptCount: 0,
    taskId: null,
    generatedFromFeatureId: null,
    generatedFromRunId: null,
    blockedReason: null,
    orderIndex: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeAssertion(milestoneId: string, overrides: Partial<Assertion> = {}): Assertion {
  return {
    id: generateAssertionId(),
    milestoneId,
    title: 'a',
    assertion: 'all green',
    status: AssertionStatus.Pending,
    orderIndex: 0,
    featureIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeInterview(overrides: Partial<InterviewSession> = {}): InterviewSession {
  return {
    id: generateInterviewSessionId(),
    taskId: TASK_ID,
    status: InterviewSessionStatus.Active,
    state: {
      step: 1,
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

//#endregion

//#region Milestones

describe('milestones CRUD', () => {
  it('round-trips a milestone', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    await saveMilestone(ctx, TASK_ID, m);
    const loaded = await loadMilestone(ctx, TASK_ID, m.id);
    expect(loaded).toEqual(m);
  });

  it('returns null for missing or malformed ids', async () => {
    const ctx = makeStoreContext();
    expect(await loadMilestone(ctx, TASK_ID, generateMilestoneId())).toBeNull();
    expect(await loadMilestone(ctx, TASK_ID, 'not-an-id')).toBeNull();
  });

  it('lists every well-formed milestone, skipping foreign files', async () => {
    const ctx = makeStoreContext();
    const a = makeMilestone();
    const b = makeMilestone({
      orderIndex: 1,
    });
    await saveMilestone(ctx, TASK_ID, a);
    await saveMilestone(ctx, TASK_ID, b);
    // Sneak in a non-json file:
    const dir = hierarchyPaths(ctx.projectRoot, TASK_ID).milestones;
    await ctx.fs.writeFile(`${dir}/README.md`, 'ignore me');

    const all = await listMilestones(ctx, TASK_ID);
    const ids = new Set(all.map((m) => m.id));
    expect(ids).toEqual(
      new Set([
        a.id,
        b.id,
      ]),
    );
  });

  it('deletes a milestone', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    await saveMilestone(ctx, TASK_ID, m);
    await deleteMilestone(ctx, TASK_ID, m.id);
    expect(await loadMilestone(ctx, TASK_ID, m.id)).toBeNull();
  });

  it('throws on a malformed milestone file (bad status on disk)', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const dir = hierarchyPaths(ctx.projectRoot, TASK_ID).milestones;
    await ctx.fs.mkdir(dir);
    await ctx.fs.writeFile(
      `${dir}/${m.id}.json`,
      JSON.stringify({
        ...m,
        status: 'invalid',
      }),
    );
    await expect(loadMilestone(ctx, TASK_ID, m.id)).rejects.toThrow();
  });

  it('list returns [] when hierarchy/ does not exist', async () => {
    const ctx = makeStoreContext();
    expect(await listMilestones(ctx, TASK_ID)).toEqual([]);
  });
});

//#endregion

//#region Slices

describe('slices CRUD', () => {
  it('round-trips a slice', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const s = makeSlice(m.id);
    await saveSlice(ctx, TASK_ID, s);
    const loaded = await loadSlice(ctx, TASK_ID, s.id);
    expect(loaded).toEqual(s);
  });

  it('lists slices', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    await saveSlice(ctx, TASK_ID, makeSlice(m.id));
    await saveSlice(
      ctx,
      TASK_ID,
      makeSlice(m.id, {
        orderIndex: 1,
      }),
    );
    expect((await listSlices(ctx, TASK_ID)).length).toBe(2);
  });

  it('deletes a slice', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const s = makeSlice(m.id);
    await saveSlice(ctx, TASK_ID, s);
    await deleteSlice(ctx, TASK_ID, s.id);
    expect(await loadSlice(ctx, TASK_ID, s.id)).toBeNull();
  });
});

//#endregion

//#region Features (per-feature subdir)

describe('features CRUD', () => {
  it('round-trips a feature into its own subdir', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const s = makeSlice(m.id);
    const f = makeFeature(s.id);
    await saveFeature(ctx, TASK_ID, f);
    const loaded = await loadFeature(ctx, TASK_ID, f.id);
    expect(loaded).toEqual(f);
  });

  it('lists features by walking the features/ directory', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const s = makeSlice(m.id);
    await saveFeature(ctx, TASK_ID, makeFeature(s.id));
    await saveFeature(
      ctx,
      TASK_ID,
      makeFeature(s.id, {
        orderIndex: 1,
      }),
    );
    expect((await listFeatures(ctx, TASK_ID)).length).toBe(2);
  });

  it('deleteFeature removes the entire subdir including future runs', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const s = makeSlice(m.id);
    const f = makeFeature(s.id);
    await saveFeature(ctx, TASK_ID, f);
    // Drop a sibling file inside the feature dir to simulate validator-runs/.
    const featureRoot = hierarchyPaths(ctx.projectRoot, TASK_ID).features;
    await ctx.fs.writeFile(`${featureRoot}/${f.id}/sibling.txt`, 'x');

    await deleteFeature(ctx, TASK_ID, f.id);

    expect(await loadFeature(ctx, TASK_ID, f.id)).toBeNull();
    await expect(ctx.fs.access(`${featureRoot}/${f.id}/sibling.txt`)).rejects.toThrow();
  });

  it('returns null for non-feature ids', async () => {
    const ctx = makeStoreContext();
    expect(await loadFeature(ctx, TASK_ID, 'not-a-feature')).toBeNull();
  });
});

//#endregion

//#region Assertions

describe('assertions CRUD', () => {
  it('round-trips an assertion with featureIds', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const featureId = generateFeatureId();
    const a = makeAssertion(m.id, {
      featureIds: [
        featureId,
      ],
    });
    await saveAssertion(ctx, TASK_ID, a);
    const loaded = await loadAssertion(ctx, TASK_ID, a.id);
    expect(loaded?.featureIds).toEqual([
      featureId,
    ]);
  });

  it('lists assertions', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    await saveAssertion(ctx, TASK_ID, makeAssertion(m.id));
    await saveAssertion(
      ctx,
      TASK_ID,
      makeAssertion(m.id, {
        orderIndex: 1,
      }),
    );
    expect((await listAssertions(ctx, TASK_ID)).length).toBe(2);
  });

  it('deletes an assertion', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const a = makeAssertion(m.id);
    await saveAssertion(ctx, TASK_ID, a);
    await deleteAssertion(ctx, TASK_ID, a.id);
    expect(await loadAssertion(ctx, TASK_ID, a.id)).toBeNull();
  });
});

//#endregion

//#region Interview sessions

describe('interview sessions CRUD', () => {
  it('round-trips a session with state payload', async () => {
    const ctx = makeStoreContext();
    const s = makeInterview({
      state: {
        questionsAsked: 2,
      },
    });
    await saveInterviewSession(ctx, TASK_ID, s);
    const loaded = await loadInterviewSession(ctx, TASK_ID, s.id);
    expect(loaded).toEqual(s);
  });

  it('lists interview sessions', async () => {
    const ctx = makeStoreContext();
    await saveInterviewSession(ctx, TASK_ID, makeInterview());
    await saveInterviewSession(ctx, TASK_ID, makeInterview());
    expect((await listInterviewSessions(ctx, TASK_ID)).length).toBe(2);
  });
});

//#endregion

//#region clearTaskHierarchy

describe('clearTaskHierarchy', () => {
  it('removes everything beneath hierarchy/', async () => {
    const ctx = makeStoreContext();
    const m = makeMilestone();
    const s = makeSlice(m.id);
    await saveMilestone(ctx, TASK_ID, m);
    await saveSlice(ctx, TASK_ID, s);
    await saveFeature(ctx, TASK_ID, makeFeature(s.id));

    await clearTaskHierarchy(ctx, TASK_ID);

    expect(await listMilestones(ctx, TASK_ID)).toEqual([]);
    expect(await listSlices(ctx, TASK_ID)).toEqual([]);
    expect(await listFeatures(ctx, TASK_ID)).toEqual([]);
  });

  it('is a no-op when hierarchy does not exist', async () => {
    const ctx = makeStoreContext();
    await clearTaskHierarchy(ctx, TASK_ID);
  });
});

//#endregion
