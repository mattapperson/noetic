import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ToolExecutionContext } from '@noetic/core';
import { AgentHarness } from '@noetic/core';
import type { z } from 'zod';

import type { Signaller } from '../../../src/commands/builtins/tasks/agent-ci-control.js';
import type { Feature } from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import {
  FeatureLoopState,
  FeatureStatus,
  generateFeatureId,
  generateSliceId,
  generateValidatorRunId,
  ValidatorRunStatus,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import { saveFeature } from '../../../src/commands/builtins/tasks/hierarchy/store.js';
import type { ValidatorContext } from '../../../src/commands/builtins/tasks/hierarchy/validator.js';
import {
  listValidatorRuns,
  recordValidatorRun,
} from '../../../src/commands/builtins/tasks/hierarchy/validator.js';
import type { ValidatorSpawn } from '../../../src/commands/builtins/tasks/hierarchy/validator-launcher.js';
import { createValidatorLauncherTool } from '../../../src/commands/builtins/tasks/hierarchy/validator-launcher-tool.js';
import type { MemFs } from '../_helpers.js';
import { makeStoreContext } from '../_helpers.js';

const TASK_ID = 'T-abcdefghij';
const NOW = '2026-04-30T00:00:00.000Z';

//#region Test seams

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

function makeCtx(): {
  ctx: ValidatorContext;
  fs: MemFs;
  projectRoot: string;
} {
  const store = makeStoreContext();
  return {
    fs: store.fs,
    projectRoot: store.projectRoot,
    ctx: {
      ...store,
      taskId: TASK_ID,
    },
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

interface ValidatorLauncherOutput {
  pid: number;
  pidStarttime: string | null;
}

/**
 * Invoke the tool and parse its output through the tool's output schema.
 * Returns a properly typed `{ pid, pidStarttime }` shape, narrowing past the
 * `Tool.execute` union signature (Promise<output> | AsyncGenerator).
 */
async function runTool(
  tool: ReturnType<typeof createValidatorLauncherTool>,
  args: z.input<typeof tool.input>,
  toolCtx: ToolExecutionContext,
): Promise<ValidatorLauncherOutput> {
  const raw = await tool.execute(args, toolCtx);
  const parsed: ValidatorLauncherOutput = tool.output.parse(raw);
  return parsed;
}

/**
 * Build a real `ToolExecutionContext` rooted on a fresh `AgentHarness`
 * configured with the given MemFs. The tool body only reaches
 * `toolCtx.fs`, but using the real harness assembly avoids type casts and
 * keeps us honest if more fields are required later.
 */
function makeToolCtx(fs: MemFs): ToolExecutionContext {
  const harness = new AgentHarness({
    name: 'validator-launcher-tool-test',
    params: {},
    fs,
  });
  const ctx = harness.createContext();
  return {
    ctx,
    harness,
    fs: harness.fs,
    shell: harness.shell,
    memory: {
      get: () => undefined,
      set: () => {
        // Not exercised by the validator-launcher tool.
      },
    },
    assembledView: ctx.itemLog.items,
    lastStepMeta: ctx.lastStepMeta,
  };
}

//#endregion

describe('validatorLauncherTool input schema', () => {
  it('rejects missing taskId', async () => {
    const tool = createValidatorLauncherTool();
    const result = tool.input.safeParse({
      featureId: generateFeatureId(),
      runId: generateValidatorRunId(),
      command: 'echo',
      args: [
        'hi',
      ],
      projectRoot: '/repo',
    });
    expect(result.success).toBe(false);
  });

  it('rejects malformed runId', async () => {
    const tool = createValidatorLauncherTool();
    const result = tool.input.safeParse({
      taskId: TASK_ID,
      featureId: generateFeatureId(),
      runId: 'not-a-valid-run-id',
      command: 'echo',
      args: [
        'hi',
      ],
      projectRoot: '/repo',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty command', async () => {
    const tool = createValidatorLauncherTool();
    const result = tool.input.safeParse({
      taskId: TASK_ID,
      featureId: generateFeatureId(),
      runId: generateValidatorRunId(),
      command: '',
      args: [],
      projectRoot: '/repo',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty projectRoot', async () => {
    const tool = createValidatorLauncherTool();
    const result = tool.input.safeParse({
      taskId: TASK_ID,
      featureId: generateFeatureId(),
      runId: generateValidatorRunId(),
      command: 'echo',
      args: [],
      projectRoot: '',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a fully-populated valid input', async () => {
    const tool = createValidatorLauncherTool();
    const result = tool.input.safeParse({
      taskId: TASK_ID,
      featureId: generateFeatureId(),
      runId: generateValidatorRunId(),
      command: 'echo',
      args: [
        'hi',
      ],
      projectRoot: '/repo',
    });
    expect(result.success).toBe(true);
  });
});

describe('validatorLauncherTool execute', () => {
  it('happy path: spawns child, returns pid and pidStarttime, patches the run row', async () => {
    const { ctx, fs } = makeCtx();
    const featureId = generateFeatureId();
    await seedFeature(ctx, featureId);
    const run = await recordValidatorRun(ctx, {
      featureId,
      status: ValidatorRunStatus.Running,
    });
    const child = makeChild(4321);
    const tool = createValidatorLauncherTool({
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

    const out = await runTool(
      tool,
      {
        taskId: TASK_ID,
        featureId,
        runId: run.id,
        command: 'echo',
        args: [
          'hi',
        ],
        projectRoot: ctx.projectRoot,
      },
      makeToolCtx(fs),
    );

    expect(out.pid).toBe(4321);
    expect(out.pidStarttime).toBe('Mon Jan 01 00:00:00 2026');
    const runs = await listValidatorRuns(ctx, featureId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.pid).toBe(4321);
    expect(runs[0]?.pidStarttime).toBe('Mon Jan 01 00:00:00 2026');
  });

  it('throws when the run row does not exist', async () => {
    const { ctx, fs } = makeCtx();
    const featureId = generateFeatureId();
    await seedFeature(ctx, featureId);
    const tool = createValidatorLauncherTool({
      spawnFn: makeSpawn(makeChild(1234)),
      signaller: makeSignaller({
        alivePids: new Set([
          1234,
        ]),
      }),
    });
    await expect(
      tool.execute(
        {
          taskId: TASK_ID,
          featureId,
          runId: generateValidatorRunId(),
          command: 'echo',
          args: [],
          projectRoot: ctx.projectRoot,
        },
        makeToolCtx(fs),
      ),
    ).rejects.toThrow(/Validator run .* not found/);
  });

  it('marks the run as error and throws when spawn returns no pid', async () => {
    const { ctx, fs } = makeCtx();
    const featureId = generateFeatureId();
    await seedFeature(ctx, featureId);
    const run = await recordValidatorRun(ctx, {
      featureId,
      status: ValidatorRunStatus.Running,
    });
    const tool = createValidatorLauncherTool({
      spawnFn: makeSpawn(makeChild(undefined)),
      signaller: makeSignaller(),
    });
    await expect(
      tool.execute(
        {
          taskId: TASK_ID,
          featureId,
          runId: run.id,
          command: 'noop',
          args: [],
          projectRoot: ctx.projectRoot,
        },
        makeToolCtx(fs),
      ),
    ).rejects.toThrow(/no pid returned by spawn/);
    const runs = await listValidatorRuns(ctx, featureId);
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Error);
  });

  it('marks the run as error when the kernel reports no live pid', async () => {
    const { ctx, fs } = makeCtx();
    const featureId = generateFeatureId();
    await seedFeature(ctx, featureId);
    const run = await recordValidatorRun(ctx, {
      featureId,
      status: ValidatorRunStatus.Running,
    });
    const tool = createValidatorLauncherTool({
      spawnFn: makeSpawn(makeChild(9999)),
      signaller: makeSignaller({
        alivePids: new Set<number>(),
      }),
    });
    await expect(
      tool.execute(
        {
          taskId: TASK_ID,
          featureId,
          runId: run.id,
          command: 'noop',
          args: [],
          projectRoot: ctx.projectRoot,
        },
        makeToolCtx(fs),
      ),
    ).rejects.toThrow(/did not start/);
    const runs = await listValidatorRuns(ctx, featureId);
    expect(runs[0]?.status).toBe(ValidatorRunStatus.Error);
  });
});
