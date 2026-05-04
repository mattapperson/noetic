import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { saveTask } from '../../../src/commands/builtins/tasks/fs-store.js';
import type { ValidatorShellSpawn } from '../../../src/commands/builtins/tasks/hierarchy/daemon-validator.js';
import { createShellValidator } from '../../../src/commands/builtins/tasks/hierarchy/daemon-validator.js';
import type {
  Feature,
  ValidatorRun,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import {
  AssertionStatus,
  FeatureLoopState,
  FeatureStatus,
  ValidatorRunStatus,
} from '../../../src/commands/builtins/tasks/hierarchy/schemas.js';
import {
  AutopilotState,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '../../../src/commands/builtins/tasks/schemas.js';
import { makeStoreContext } from '../_helpers.js';

interface FakeChildOptions {
  readonly exitCode: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly throwOnSpawn?: Error;
}

function makeFakeChild(opts: FakeChildOptions): ReturnType<ValidatorShellSpawn> {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(emitter, {
    stdout,
    stderr,
  }) satisfies ReturnType<ValidatorShellSpawn>;
  setImmediate(() => {
    if (opts.stdout !== undefined) {
      stdout.write(Buffer.from(opts.stdout, 'utf-8'));
    }
    if (opts.stderr !== undefined) {
      stderr.write(Buffer.from(opts.stderr, 'utf-8'));
    }
    emitter.emit('exit', opts.exitCode);
  });
  return child;
}

const LEAF_TASK_ID = 'T-leaf000000';

async function seedLeafTask(
  ctx: ReturnType<typeof makeStoreContext>,
  worktreePath: string | null,
): Promise<void> {
  const now = '2026-05-01T00:00:00.000Z';
  await saveTask(ctx, {
    id: LEAF_TASK_ID,
    source: TaskSource.Worktree,
    title: 'leaf',
    projectRoot: ctx.projectRoot,
    worktreePath,
    branch: 'feat/x',
    headSha: null,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: false,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
}

function makeFeature(overrides: Partial<Feature> = {}): Feature {
  const now = '2026-05-01T00:00:00.000Z';
  return {
    id: 'F-abc1234567',
    sliceId: 'SL-slice00000',
    title: 'F1',
    description: null,
    acceptanceCriteria: 'tests pass',
    status: FeatureStatus.Triaged,
    loopState: FeatureLoopState.Validating,
    implementationAttemptCount: 1,
    validatorAttemptCount: 0,
    taskId: LEAF_TASK_ID,
    generatedFromFeatureId: null,
    generatedFromRunId: null,
    blockedReason: null,
    orderIndex: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeRun(): ValidatorRun {
  return {
    id: 'V-run000000',
    featureId: 'F-abc1234567',
    startedAt: '2026-05-01T00:00:00.000Z',
    completedAt: null,
    status: ValidatorRunStatus.Running,
    result: null,
    assertionOutcomes: [],
    pid: null,
    pidStarttime: null,
    pausedAt: null,
  };
}

describe('createShellValidator', () => {
  it('returns pass on exit code 0', async () => {
    const ctx = makeStoreContext();
    await seedLeafTask(ctx, '/repo/.worktrees/feat-x');
    const validator = createShellValidator({
      spawnFn: () =>
        makeFakeChild({
          exitCode: 0,
          stdout: 'all tests passed',
        }),
    });
    const outcome = await validator({
      ctx: {
        ...ctx,
        taskId: 'T-parent0000',
      },
      feature: makeFeature(),
      assertions: [],
      run: makeRun(),
    });
    expect(outcome.status).toBe('pass');
    expect(outcome.summary).toContain('all tests passed');
  });

  it('returns fail on non-zero exit code', async () => {
    const ctx = makeStoreContext();
    await seedLeafTask(ctx, '/repo/.worktrees/feat-x');
    const validator = createShellValidator({
      spawnFn: () =>
        makeFakeChild({
          exitCode: 1,
          stderr: '5 tests failed',
        }),
    });
    const outcome = await validator({
      ctx: {
        ...ctx,
        taskId: 'T-parent0000',
      },
      feature: makeFeature(),
      assertions: [],
      run: makeRun(),
    });
    expect(outcome.status).toBe('fail');
    expect(outcome.summary).toContain('5 tests failed');
  });

  it('returns error when the child is killed by a signal (exitCode null)', async () => {
    const ctx = makeStoreContext();
    await seedLeafTask(ctx, '/repo/.worktrees/feat-x');
    const validator = createShellValidator({
      spawnFn: () =>
        makeFakeChild({
          exitCode: null,
        }),
    });
    const outcome = await validator({
      ctx: {
        ...ctx,
        taskId: 'T-parent0000',
      },
      feature: makeFeature(),
      assertions: [],
      run: makeRun(),
    });
    expect(outcome.status).toBe('error');
    expect(outcome.summary).toContain('killed by a signal');
  });

  it('returns error when the leaf task has no worktree provisioned yet', async () => {
    const ctx = makeStoreContext();
    await seedLeafTask(ctx, null);
    let spawnCalls = 0;
    const validator = createShellValidator({
      spawnFn: () => {
        spawnCalls += 1;
        return makeFakeChild({
          exitCode: 0,
        });
      },
    });
    const outcome = await validator({
      ctx: {
        ...ctx,
        taskId: 'T-parent0000',
      },
      feature: makeFeature(),
      assertions: [],
      run: makeRun(),
    });
    expect(outcome.status).toBe('error');
    expect(outcome.summary).toContain('no worktree');
    expect(spawnCalls).toBe(0);
  });

  it('returns error when the feature is not linked to a leaf task', async () => {
    const ctx = makeStoreContext();
    const validator = createShellValidator({
      spawnFn: () =>
        makeFakeChild({
          exitCode: 0,
        }),
    });
    const outcome = await validator({
      ctx: {
        ...ctx,
        taskId: 'T-parent0000',
      },
      feature: makeFeature({
        taskId: null,
      }),
      assertions: [],
      run: makeRun(),
    });
    expect(outcome.status).toBe('error');
    expect(outcome.summary).toContain('no linked leaf task');
  });

  it('returns error when the leaf task is missing on disk', async () => {
    const ctx = makeStoreContext();
    // Don't seed the task — feature claims taskId LEAF_TASK_ID but it doesn't exist.
    const validator = createShellValidator({
      spawnFn: () =>
        makeFakeChild({
          exitCode: 0,
        }),
    });
    const outcome = await validator({
      ctx: {
        ...ctx,
        taskId: 'T-parent0000',
      },
      feature: makeFeature(),
      assertions: [],
      run: makeRun(),
    });
    expect(outcome.status).toBe('error');
    expect(outcome.summary).toContain('not found');
  });

  it('returns error when spawn throws synchronously', async () => {
    const ctx = makeStoreContext();
    await seedLeafTask(ctx, '/repo/.worktrees/feat-x');
    const validator = createShellValidator({
      spawnFn: () => {
        throw new Error('spawn EACCES');
      },
    });
    const outcome = await validator({
      ctx: {
        ...ctx,
        taskId: 'T-parent0000',
      },
      feature: makeFeature(),
      assertions: [],
      run: makeRun(),
    });
    expect(outcome.status).toBe('error');
    expect(outcome.summary).toContain('spawn EACCES');
  });

  it('clamps a very large output payload', async () => {
    const ctx = makeStoreContext();
    await seedLeafTask(ctx, '/repo/.worktrees/feat-x');
    const big = 'x'.repeat(10000);
    const validator = createShellValidator({
      maxOutputBytes: 100,
      spawnFn: () =>
        makeFakeChild({
          exitCode: 0,
          stdout: big,
        }),
    });
    const outcome = await validator({
      ctx: {
        ...ctx,
        taskId: 'T-parent0000',
      },
      feature: makeFeature(),
      assertions: [],
      run: makeRun(),
    });
    expect(outcome.status).toBe('pass');
    expect(outcome.summary.length).toBeLessThan(big.length);
    expect(outcome.summary).toContain('truncated');
    // Reference unused imports so the linter doesn't strip them via the
    // schema enums (kept explicit for type clarity at call sites).
    expect(AssertionStatus.Pending).toBe('pending');
  });

  it('clamps multi-byte output to the byte budget without exceeding it', async () => {
    // Each '🔥' is 4 bytes in UTF-8 / 2 UTF-16 code units. With a 16-byte
    // budget the byte-correct truncation must keep at most 4 emojis (16
    // bytes) — a char-indexed slice would let through 16 emojis (64 bytes).
    const ctx = makeStoreContext();
    await seedLeafTask(ctx, '/repo/.worktrees/feat-x');
    const big = '🔥'.repeat(64); // 256 bytes
    const validator = createShellValidator({
      maxOutputBytes: 16,
      spawnFn: () =>
        makeFakeChild({
          exitCode: 0,
          stdout: big,
        }),
    });
    const outcome = await validator({
      ctx: {
        ...ctx,
        taskId: 'T-parent0000',
      },
      feature: makeFeature(),
      assertions: [],
      run: makeRun(),
    });
    expect(outcome.status).toBe('pass');
    // Strip the trailing "\n…[truncated]" suffix and count payload bytes only.
    const truncatedSuffix = '\n…[truncated]';
    expect(outcome.summary.endsWith(truncatedSuffix)).toBe(true);
    const payload = outcome.summary.slice(0, -truncatedSuffix.length);
    expect(Buffer.byteLength(payload, 'utf-8')).toBeLessThanOrEqual(16);
  });
});
