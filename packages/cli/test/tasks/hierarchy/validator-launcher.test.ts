import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';

import type { Signaller } from '../../../src/commands/builtins/tasks/agent-ci-control.js';
import type { Feature } from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import {
  FeatureLoopState,
  FeatureStatus,
  generateFeatureId,
  generateSliceId,
  ValidatorRunStatus,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import { saveFeature } from '../../../src/commands/builtins/tasks/hierarchy/store.js';
import type { ValidatorContext } from '../../../src/commands/builtins/tasks/hierarchy/validator.js';
import { listValidatorRuns } from '../../../src/commands/builtins/tasks/hierarchy/validator.js';
import type { ValidatorSpawn } from '../../../src/commands/builtins/tasks/hierarchy/validator-launcher.js';
import {
  startExternalValidatorRun,
  ValidatorSpawnError,
} from '../../../src/commands/builtins/tasks/hierarchy/validator-launcher.js';
import { makeStoreContext } from '../_helpers.js';

const TASK_ID = 'T-abcdefghij';
const NOW = '2026-04-30T00:00:00.000Z';

function makeSignaller(opts?: {
  alivePids?: ReadonlySet<number>;
  startTimeFor?: ReadonlyMap<number, string | null>;
}): Signaller {
  const alive = opts?.alivePids ?? new Set<number>();
  const startTimes = opts?.startTimeFor ?? new Map<number, string | null>();
  return {
    kill: () => {
      // Tests do not exercise direct kills here.
    },
    isAlive: (pid) => alive.has(pid),
    startTime: (pid) => startTimes.get(pid) ?? null,
  };
}

interface MockChild {
  pid?: number;
  unref(): void;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

function makeChild(pid?: number): MockChild {
  const ee = new EventEmitter();
  return {
    pid,
    unref: () => {
      // pretend
    },
    on: (event, listener) => ee.on(event, listener),
  };
}

function makeSpawn(child: MockChild): ValidatorSpawn {
  return () => child;
}

function makeCtx(): ValidatorContext {
  const store = makeStoreContext();
  return {
    ...store,
    taskId: TASK_ID,
  };
}

async function seedFeature(ctx: ValidatorContext, featureId: string): Promise<Feature> {
  const feature: Feature = {
    id: featureId,
    sliceId: generateSliceId(),
    title: 'f',
    description: null,
    acceptanceCriteria: 'a',
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
  };
  await saveFeature(ctx, ctx.taskId, feature);
  return feature;
}

describe('startExternalValidatorRun', () => {
  it('records a run, captures pid and pidStarttime, returns the row', async () => {
    const ctx = makeCtx();
    const featureId = generateFeatureId();
    await seedFeature(ctx, featureId);
    const child = makeChild(4321);
    const result = await startExternalValidatorRun({
      ctx,
      featureId,
      command: 'echo',
      args: [
        'hi',
      ],
      spawnFn: makeSpawn(child),
      signaller: makeSignaller({
        alivePids: new Set([
          4321,
        ]),
        startTimeFor: new Map([
          [
            4321,
            'Mon Jan 01 00:00:00 2026',
          ],
        ]),
      }),
    });
    expect(result.pid).toBe(4321);
    expect(result.command).toBe('echo');
    const runs = await listValidatorRuns(ctx, featureId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.pid).toBe(4321);
    expect(runs[0]?.pidStarttime).toBe('Mon Jan 01 00:00:00 2026');
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Running);
  });

  it('marks the run as error and throws when spawn returns no pid', async () => {
    const ctx = makeCtx();
    const featureId = generateFeatureId();
    await seedFeature(ctx, featureId);
    const child = makeChild(undefined);
    await expect(
      startExternalValidatorRun({
        ctx,
        featureId,
        command: 'noop',
        args: [],
        spawnFn: makeSpawn(child),
        signaller: makeSignaller(),
      }),
    ).rejects.toBeInstanceOf(ValidatorSpawnError);
    const runs = await listValidatorRuns(ctx, featureId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Error);
    expect(runs[0]?.completedAt).not.toBeNull();
  });

  it('marks the run as error when the kernel reports no live pid', async () => {
    const ctx = makeCtx();
    const featureId = generateFeatureId();
    await seedFeature(ctx, featureId);
    const child = makeChild(9999);
    await expect(
      startExternalValidatorRun({
        ctx,
        featureId,
        command: 'noop',
        args: [],
        spawnFn: makeSpawn(child),
        signaller: makeSignaller({
          alivePids: new Set<number>(),
        }),
      }),
    ).rejects.toBeInstanceOf(ValidatorSpawnError);
    const runs = await listValidatorRuns(ctx, featureId);
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Error);
  });

  it('rejects an empty command outright', async () => {
    const ctx = makeCtx();
    await expect(
      startExternalValidatorRun({
        ctx,
        featureId: generateFeatureId(),
        command: '   ',
        args: [],
        spawnFn: makeSpawn(makeChild()),
        signaller: makeSignaller(),
      }),
    ).rejects.toThrow(/validator command is required/);
  });
});
