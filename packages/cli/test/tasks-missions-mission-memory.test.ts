import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ExecutionContext, ScopedStorage, StorageAdapter } from '@noetic/core';
import { createLocalFsAdapter, createLocalShellAdapter, Slot } from '@noetic/core';
import { z } from 'zod';

import { openTasksDatabaseAtPath } from '../src/commands/builtins/tasks/db/index.js';
import type { MissionFeatureRecord } from '../src/commands/builtins/tasks/db/schema.js';
import {
  addAssertion,
  addFeature,
  addMilestone,
  addSlice,
  computeMissionStatus,
  createMission,
  getMission,
  resetOpenMissionsDatabase,
  setOpenMissionsDatabase,
} from '../src/commands/builtins/tasks/missions/store.js';
import type { MissionState } from '../src/memory/mission-memory.js';
import { missionMemory } from '../src/memory/mission-memory.js';

//#region Test fixtures

let cwd: string;
let dbPath: string;

function freshCwd(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Type-erased identity helper used at the storage boundary, mirroring the
 * `frameworkCast` pattern from @noetic/core (which is not part of the public
 * barrel). The runtime value is unchanged — TypeScript cannot express the
 * "caller picks T at the read site" invariant of a key-value bag.
 */
function asAny<T>(value: unknown): T {
  // @ts-expect-error — intentional cast at storage boundary, identity at runtime.
  return value;
}

function makeMapStorageBackend(): StorageAdapter {
  const store = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const val = store.get(key);
      return val === undefined ? null : asAny<T>(val);
    },
    async set<T>(key: string, value: T): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    async list(prefix: string): Promise<string[]> {
      return [
        ...store.keys(),
      ].filter((k) => k.startsWith(prefix));
    },
  };
}

function makeScopedStorage(): ScopedStorage {
  const backend = makeMapStorageBackend();
  return {
    get: backend.get.bind(backend),
    set: backend.set.bind(backend),
    delete: backend.delete.bind(backend),
    async list(prefix?: string): Promise<string[]> {
      return backend.list(prefix ?? '');
    },
  };
}

function makeExecutionContext(): ExecutionContext {
  return {
    executionId: 'exec-1',
    threadId: 'thread-1',
    resourceId: 'user-1',
    depth: 0,
    stepNumber: 0,
    tokenUsage: {
      input: 0,
      output: 0,
    },
    cost: 0,
    fs: createLocalFsAdapter(),
    shell: createLocalShellAdapter(),
    tokenize: (text: string) => Math.ceil(text.length / 4),
    trace: {
      setAttribute() {},
      addEvent() {},
    },
    readLayerState: <T>(_layerId: string): T | undefined => undefined,
  };
}

interface SeededMission {
  cwd: string;
  missionId: string;
  milestoneId: string;
  sliceId: string;
  feature: MissionFeatureRecord;
  assertionId: string;
}

function seedMission(): SeededMission {
  const mission = createMission(cwd, {
    title: 'Test mission',
    description: 'A test mission for the memory layer.',
  });
  const milestone = addMilestone(cwd, {
    missionId: mission.id,
    title: 'Milestone 1',
    verification: 'Milestone passes when X.',
    orderIndex: 0,
  });
  const slice = addSlice(cwd, {
    milestoneId: milestone.id,
    title: 'Slice A',
    verification: 'Slice passes when Y.',
    orderIndex: 0,
  });
  const feature = addFeature(cwd, {
    sliceId: slice.id,
    title: 'Feature 1',
    description: 'Implement the thing.',
    acceptanceCriteria: [
      'criterion-A',
      'criterion-B',
    ],
    orderIndex: 0,
  });
  const assertion = addAssertion(cwd, {
    milestoneId: milestone.id,
    title: 'A1',
    assertion: 'Thing is implemented.',
    orderIndex: 0,
    featureIds: [
      feature.id,
    ],
  });
  return {
    cwd,
    missionId: mission.id,
    milestoneId: milestone.id,
    sliceId: slice.id,
    feature,
    assertionId: assertion.id,
  };
}

beforeEach(() => {
  cwd = freshCwd('noetic-mission-memory-');
  dbPath = join(cwd, 'tasks.sqlite');
  setOpenMissionsDatabase(() => openTasksDatabaseAtPath(dbPath));
});

afterEach(() => {
  resetOpenMissionsDatabase();
});

//#endregion

//#region Configuration / wiring

describe('missionMemory layer config', () => {
  test('positions itself at PROCEDURAL - 5 (one slot below planMemory)', () => {
    const layer = missionMemory({
      cwd,
    });
    expect(layer.slot).toBe(Slot.PROCEDURAL - 5);
    expect(layer.id).toBe('mission-memory');
    expect(layer.scope).toBe('thread');
  });

  test('honours scope override', () => {
    const layer = missionMemory({
      cwd,
      scope: 'global',
    });
    expect(layer.scope).toBe('global');
  });

  test('exposes provides keys: current, getFeature, markFeatureComplete, queryAssertions', () => {
    const layer = missionMemory({
      cwd,
    });
    expect(layer.provides).toBeDefined();
    if (!layer.provides) {
      throw new Error('expected provides');
    }
    expect(Object.keys(layer.provides).sort()).toEqual(
      [
        'current',
        'getFeature',
        'markFeatureComplete',
        'queryAssertions',
      ].sort(),
    );
  });
});

//#endregion

//#region init

describe('missionMemory.init', () => {
  test('returns initial state from config when storage is empty', async () => {
    const layer = missionMemory({
      cwd,
      initial: {
        activeMissionId: null,
        activeFeatureId: null,
      },
    });
    const storage = makeScopedStorage();
    if (!layer.hooks.init) {
      throw new Error('init hook missing');
    }
    const result = await layer.hooks.init({
      storage,
      scopeKey: 'thread:test',
      ctx: makeExecutionContext(),
    });
    expect(result.state.cwd).toBe(cwd);
    expect(result.state.activeMissionId).toBeNull();
    expect(result.state.activeFeatureId).toBeNull();
  });

  test('rehydrates persisted state when storage has a saved record', async () => {
    const seeded = seedMission();
    const layer = missionMemory({
      cwd,
    });
    const storage = makeScopedStorage();
    const persisted: MissionState = {
      cwd: seeded.cwd,
      activeMissionId: seeded.missionId,
      activeFeatureId: seeded.feature.id,
    };
    await storage.set('state', persisted);
    if (!layer.hooks.init) {
      throw new Error('init hook missing');
    }
    const result = await layer.hooks.init({
      storage,
      scopeKey: 'thread:test',
      ctx: makeExecutionContext(),
    });
    expect(result.state).toEqual(persisted);
  });
});

//#endregion

//#region recall

describe('missionMemory.recall', () => {
  test('returns null when no active feature is set', async () => {
    const layer = missionMemory({
      cwd,
    });
    if (!layer.hooks.recall) {
      throw new Error('recall hook missing');
    }
    const ctx = makeExecutionContext();
    const result = await layer.hooks.recall({
      log: {
        get items() {
          return [];
        },
        append() {},
      },
      query: '',
      ctx,
      state: {
        cwd,
        activeMissionId: null,
        activeFeatureId: null,
      },
      budget: 1000,
    });
    expect(result).toBeNull();
  });

  test('returns developer message wrapping mission_context XML when active', async () => {
    const seeded = seedMission();
    const layer = missionMemory({
      cwd,
    });
    if (!layer.hooks.recall) {
      throw new Error('recall hook missing');
    }
    const result = await layer.hooks.recall({
      log: {
        get items() {
          return [];
        },
        append() {},
      },
      query: '',
      ctx: makeExecutionContext(),
      state: {
        cwd: seeded.cwd,
        activeMissionId: seeded.missionId,
        activeFeatureId: seeded.feature.id,
      },
      budget: 1000,
    });
    expect(result).not.toBeNull();
    if (result === null || typeof result === 'string') {
      throw new Error('expected RecallResult');
    }
    expect(result.items).toHaveLength(1);
    expect(result.tokenCount).toBeGreaterThan(0);
    const message = result.items[0];
    if (message.type !== 'message') {
      throw new Error('expected message item');
    }
    expect(message.role).toBe('developer');
    const text = message.content[0];
    if (text.type !== 'input_text') {
      throw new Error('expected input_text part');
    }
    expect(text.text).toContain('<mission_context>');
    expect(text.text).toContain(`title="${seeded.feature.title}"`);
    expect(text.text).toContain('<criterion>criterion-A</criterion>');
    expect(text.text).toContain('<criterion>criterion-B</criterion>');
    expect(text.text).toContain('<assertion');
  });

  test('returns null when active feature id refers to a missing feature row', async () => {
    const seeded = seedMission();
    const layer = missionMemory({
      cwd,
    });
    if (!layer.hooks.recall) {
      throw new Error('recall hook missing');
    }
    const result = await layer.hooks.recall({
      log: {
        get items() {
          return [];
        },
        append() {},
      },
      query: '',
      ctx: makeExecutionContext(),
      state: {
        cwd: seeded.cwd,
        activeMissionId: seeded.missionId,
        activeFeatureId: 'feature-that-does-not-exist',
      },
      budget: 1000,
    });
    expect(result).toBeNull();
  });

  test('escapes XML-special characters in titles and descriptions', async () => {
    const mission = createMission(cwd, {
      title: 'Title with <tag> & "quotes"',
      description: "And 'apos' too",
    });
    const milestone = addMilestone(cwd, {
      missionId: mission.id,
      title: 'M1',
      verification: 'v',
      orderIndex: 0,
    });
    const slice = addSlice(cwd, {
      milestoneId: milestone.id,
      title: 'S1',
      verification: 'v',
      orderIndex: 0,
    });
    const feature = addFeature(cwd, {
      sliceId: slice.id,
      title: 'F1',
      description: '',
      acceptanceCriteria: [],
      orderIndex: 0,
    });
    const layer = missionMemory({
      cwd,
    });
    if (!layer.hooks.recall) {
      throw new Error('recall hook missing');
    }
    const result = await layer.hooks.recall({
      log: {
        get items() {
          return [];
        },
        append() {},
      },
      query: '',
      ctx: makeExecutionContext(),
      state: {
        cwd,
        activeMissionId: mission.id,
        activeFeatureId: feature.id,
      },
      budget: 1000,
    });
    if (result === null || typeof result === 'string') {
      throw new Error('expected RecallResult');
    }
    const text = result.items[0];
    if (text.type !== 'message' || text.content[0].type !== 'input_text') {
      throw new Error('expected message + input_text');
    }
    const body = text.content[0].text;
    expect(body).toContain('Title with &lt;tag&gt; &amp; &quot;quotes&quot;');
    expect(body).toContain('And &apos;apos&apos; too');
  });
});

//#endregion

//#region provides

describe('missionMemory.provides', () => {
  test('current data provider returns null when no active feature', () => {
    const layer = missionMemory({
      cwd,
    });
    if (!layer.provides?.current || layer.provides.current.kind !== 'data') {
      throw new Error('expected data provider');
    }
    const value = layer.provides.current.read({
      cwd,
      activeMissionId: null,
      activeFeatureId: null,
    });
    expect(value).toBeNull();
  });

  test('current data provider returns mission/slice/feature/assertions snapshot when active', () => {
    const seeded = seedMission();
    const layer = missionMemory({
      cwd,
    });
    if (!layer.provides?.current || layer.provides.current.kind !== 'data') {
      throw new Error('expected data provider');
    }
    const raw = layer.provides.current.read({
      cwd: seeded.cwd,
      activeMissionId: seeded.missionId,
      activeFeatureId: seeded.feature.id,
    });
    expect(raw).not.toBeNull();
    const SnapshotSchema = z.object({
      mission: z.object({
        id: z.string(),
      }),
      slice: z.object({
        id: z.string(),
      }),
      feature: z.object({
        id: z.string(),
      }),
      assertions: z.array(
        z.object({
          id: z.string(),
        }),
      ),
    });
    const value = SnapshotSchema.parse(raw);
    expect(value.mission.id).toBe(seeded.missionId);
    expect(value.slice.id).toBe(seeded.sliceId);
    expect(value.feature.id).toBe(seeded.feature.id);
    expect(value.assertions.map((a) => a.id)).toEqual([
      seeded.assertionId,
    ]);
  });

  test('getFeature returns the feature record + parsed acceptanceCriteria', async () => {
    const seeded = seedMission();
    const layer = missionMemory({
      cwd,
    });
    const fn = layer.provides?.getFeature;
    if (!fn || fn.kind !== 'function') {
      throw new Error('expected function provider');
    }
    const result = await fn.execute(
      {
        featureId: seeded.feature.id,
      },
      {
        cwd: seeded.cwd,
        activeMissionId: seeded.missionId,
        activeFeatureId: seeded.feature.id,
      },
      makeExecutionContext(),
    );
    expect(result.result).not.toBeNull();
  });

  test('getFeature returns null when activeMissionId is unset', async () => {
    const seeded = seedMission();
    const layer = missionMemory({
      cwd,
    });
    const fn = layer.provides?.getFeature;
    if (!fn || fn.kind !== 'function') {
      throw new Error('expected function provider');
    }
    const result = await fn.execute(
      {
        featureId: seeded.feature.id,
      },
      {
        cwd: seeded.cwd,
        activeMissionId: null,
        activeFeatureId: null,
      },
      makeExecutionContext(),
    );
    expect(result.result).toBeNull();
  });

  test('getFeature returns null for an unknown feature id', async () => {
    const seeded = seedMission();
    const layer = missionMemory({
      cwd,
    });
    const fn = layer.provides?.getFeature;
    if (!fn || fn.kind !== 'function') {
      throw new Error('expected function provider');
    }
    const result = await fn.execute(
      {
        featureId: 'no-such-feature',
      },
      {
        cwd: seeded.cwd,
        activeMissionId: seeded.missionId,
        activeFeatureId: seeded.feature.id,
      },
      makeExecutionContext(),
    );
    expect(result.result).toBeNull();
  });

  test('queryAssertions returns assertion rows with status', async () => {
    const seeded = seedMission();
    const layer = missionMemory({
      cwd,
    });
    const fn = layer.provides?.queryAssertions;
    if (!fn || fn.kind !== 'function') {
      throw new Error('expected function provider');
    }
    const result = await fn.execute(
      {
        featureId: seeded.feature.id,
      },
      {
        cwd: seeded.cwd,
        activeMissionId: seeded.missionId,
        activeFeatureId: seeded.feature.id,
      },
      makeExecutionContext(),
    );
    const AssertionListSchema = z.array(
      z.object({
        id: z.string(),
        statement: z.string(),
        status: z.string(),
      }),
    );
    const list = AssertionListSchema.parse(result.result);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(seeded.assertionId);
    expect(list[0].statement).toBe('Thing is implemented.');
    expect(list[0].status).toBe('pending');
  });

  test('queryAssertions returns empty array when no active mission', async () => {
    const layer = missionMemory({
      cwd,
    });
    const fn = layer.provides?.queryAssertions;
    if (!fn || fn.kind !== 'function') {
      throw new Error('expected function provider');
    }
    const result = await fn.execute(
      {
        featureId: 'anything',
      },
      {
        cwd,
        activeMissionId: null,
        activeFeatureId: null,
      },
      makeExecutionContext(),
    );
    expect(result.result).toEqual([]);
  });

  test('markFeatureComplete flips the feature loop state and recomputes mission status', async () => {
    const seeded = seedMission();
    const layer = missionMemory({
      cwd,
    });
    const fn = layer.provides?.markFeatureComplete;
    if (!fn || fn.kind !== 'function') {
      throw new Error('expected function provider');
    }
    const raw = await fn.execute(
      {
        featureId: seeded.feature.id,
      },
      {
        cwd: seeded.cwd,
        activeMissionId: seeded.missionId,
        activeFeatureId: seeded.feature.id,
      },
      makeExecutionContext(),
    );
    const MarkResultSchema = z.object({
      result: z.object({
        ok: z.literal(true),
        newMissionStatus: z.string(),
      }),
    });
    const parsed = MarkResultSchema.parse(raw);
    expect(parsed.result.ok).toBe(true);
    const expected = computeMissionStatus(cwd, seeded.missionId);
    expect(parsed.result.newMissionStatus).toBe(expected);
    const fresh = getMission(cwd, seeded.missionId);
    expect(fresh?.status).toBe(expected);
  });

  test('markFeatureComplete throws when there is no active mission', async () => {
    const seeded = seedMission();
    const layer = missionMemory({
      cwd,
    });
    const fn = layer.provides?.markFeatureComplete;
    if (!fn || fn.kind !== 'function') {
      throw new Error('expected function provider');
    }
    await expect(
      fn.execute(
        {
          featureId: seeded.feature.id,
        },
        {
          cwd: seeded.cwd,
          activeMissionId: null,
          activeFeatureId: null,
        },
        makeExecutionContext(),
      ),
    ).rejects.toThrow(/no active mission/i);
  });
});

//#endregion

//#region onSpawn

describe('missionMemory.onSpawn', () => {
  test('clones parent state via structuredClone, isolating mutations', async () => {
    const layer = missionMemory({
      cwd,
    });
    if (!layer.hooks.onSpawn) {
      throw new Error('onSpawn hook missing');
    }
    const parentState: MissionState = {
      cwd,
      activeMissionId: 'mission-1',
      activeFeatureId: 'feature-1',
    };
    const result = await layer.hooks.onSpawn({
      parentState,
      childCtx: makeExecutionContext(),
    });
    expect(result).not.toBeNull();
    if (result === null) {
      throw new Error('expected SpawnResult');
    }
    expect(result.childState).toEqual(parentState);
    expect(result.childState).not.toBe(parentState);
    if (result.childState !== null) {
      result.childState.activeFeatureId = 'feature-2';
    }
    expect(parentState.activeFeatureId).toBe('feature-1');
  });
});

//#endregion
