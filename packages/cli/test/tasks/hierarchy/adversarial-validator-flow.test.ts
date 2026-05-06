import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  AutopilotState,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic/code-agent/tasks/schema';
import { saveTask } from '@noetic/code-agent/tasks/store/fs-node';
import type {
  AdversarialReviewOutput,
  ValidatorShellSpawn,
} from '../../../src/tasks/runtime/hierarchy/adversarial-validator-flow.js';
import {
  buildAdversarialPrompt,
  combineOutcomes,
  createDefaultRunAgentCi,
} from '../../../src/tasks/runtime/hierarchy/adversarial-validator-flow.js';
import type { Assertion, Feature } from '../../../src/tasks/runtime/hierarchy/schemas.js';
import {
  AssertionStatus,
  FeatureLoopState,
  FeatureStatus,
} from '../../../src/tasks/runtime/hierarchy/schemas.js';
import { makeStoreContext } from '../_helpers.js';

//#region Helpers

interface FakeChildOptions {
  readonly exitCode: number | null;
  readonly stdout?: string;
  readonly stderr?: string;
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
const FEATURE_ID = 'F-abc1234567';
const ASSERTION_ID_A = 'A-aaa00aaa00';
const ASSERTION_ID_B = 'A-bbb00bbb00';

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

function _makeFeature(): Feature {
  const now = '2026-05-01T00:00:00.000Z';
  return {
    id: FEATURE_ID,
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
  };
}

function makeAssertion(id: string, title: string): Assertion {
  const now = '2026-05-01T00:00:00.000Z';
  return {
    id,
    milestoneId: 'ML-milestone0',
    title,
    assertion: `${title} must hold`,
    status: AssertionStatus.Pending,
    orderIndex: 0,
    featureIds: [
      FEATURE_ID,
    ],
    createdAt: now,
    updatedAt: now,
  };
}

const ASSERTIONS = [
  makeAssertion(ASSERTION_ID_A, 'foo holds'),
  makeAssertion(ASSERTION_ID_B, 'bar holds'),
];

//#endregion

describe('combineOutcomes', () => {
  it('passes when agent-ci passes and adversarial finds no issues', () => {
    const out = combineOutcomes({
      agentCi: {
        status: 'pass',
        summary: 'all green',
        missing: false,
      },
      review: {
        issues: [],
      },
      assertions: ASSERTIONS,
    });
    expect(out.status).toBe('pass');
    expect(out.summary).toContain('agent-ci: pass');
    expect(out.summary).toContain('no issues found');
    // All assertions reported as passed.
    expect(out.assertionOutcomes).toHaveLength(2);
    expect(out.assertionOutcomes!.every((a) => a.status === AssertionStatus.Passed)).toBe(true);
  });

  it('fails when agent-ci fails (adversarial result included verbatim)', () => {
    const out = combineOutcomes({
      agentCi: {
        status: 'fail',
        summary: 'lint failed',
        missing: false,
      },
      review: {
        issues: [],
      },
      assertions: ASSERTIONS,
    });
    expect(out.status).toBe('fail');
    expect(out.summary).toContain('agent-ci: fail');
    expect(out.summary).toContain('lint failed');
  });

  it('fails when agent-ci passes but adversarial finds issues', () => {
    const review: AdversarialReviewOutput = {
      issues: [
        {
          assertionId: ASSERTION_ID_A,
          title: 'wrong return value',
          explanation: 'expected 200 got 500',
          severity: 'high',
        },
      ],
    };
    const out = combineOutcomes({
      agentCi: {
        status: 'pass',
        summary: '',
        missing: false,
      },
      review,
      assertions: ASSERTIONS,
    });
    expect(out.status).toBe('fail');
    const failedA = out.assertionOutcomes!.find((a) => a.assertionId === ASSERTION_ID_A);
    expect(failedA?.status).toBe(AssertionStatus.Failed);
    expect(failedA?.message).toContain('wrong return value');
    // Unrelated assertion stays pending — fix-feature won't claim victory or defeat
    // for assertions the adversarial reviewer didn't flag.
    const otherB = out.assertionOutcomes!.find((a) => a.assertionId === ASSERTION_ID_B);
    expect(otherB?.status).toBe(AssertionStatus.Pending);
  });

  it('errors when agent-ci errors regardless of adversarial result', () => {
    const out = combineOutcomes({
      agentCi: {
        status: 'error',
        summary: 'spawn EPERM',
        missing: false,
      },
      review: {
        issues: [],
      },
      assertions: ASSERTIONS,
    });
    expect(out.status).toBe('error');
    expect(out.summary).toContain('agent-ci: error');
  });

  it('treats agent-ci skipped as a non-blocking outcome (overall pass when adversarial passes)', () => {
    const out = combineOutcomes({
      agentCi: {
        status: 'skipped',
        summary: 'no workflow files in .github/workflows/',
        missing: true,
      },
      review: {
        issues: [],
      },
      assertions: ASSERTIONS,
    });
    expect(out.status).toBe('pass');
    expect(out.summary).toContain('agent-ci: skipped');
  });

  it('aggregates multiple issues per assertion into one message', () => {
    const review: AdversarialReviewOutput = {
      issues: [
        {
          assertionId: ASSERTION_ID_A,
          title: 'first concern',
          explanation: 'edge case 1',
          severity: 'medium',
        },
        {
          assertionId: ASSERTION_ID_A,
          title: 'second concern',
          explanation: 'edge case 2',
          severity: 'high',
        },
      ],
    };
    const out = combineOutcomes({
      agentCi: {
        status: 'pass',
        summary: '',
        missing: false,
      },
      review,
      assertions: ASSERTIONS,
    });
    const failedA = out.assertionOutcomes!.find((a) => a.assertionId === ASSERTION_ID_A);
    expect(failedA?.message).toContain('first concern');
    expect(failedA?.message).toContain('second concern');
  });
});

describe('buildAdversarialPrompt', () => {
  it('renders feature/criteria/assertions/diff sections', () => {
    const out = buildAdversarialPrompt({
      diff: 'diff --git a/x b/x\n+hello',
      assertions: ASSERTIONS,
      featureTitle: 'F1',
      acceptanceCriteria: 'tests must pass',
    });
    expect(out).toContain('# Feature');
    expect(out).toContain('Title: F1');
    expect(out).toContain('## Acceptance criteria');
    expect(out).toContain('tests must pass');
    expect(out).toContain('## Assertions');
    expect(out).toContain(ASSERTION_ID_A);
    expect(out).toContain('## Diff');
    expect(out).toContain('+hello');
  });

  it('flags an empty diff', () => {
    const out = buildAdversarialPrompt({
      diff: '',
      assertions: [],
      featureTitle: 'F1',
      acceptanceCriteria: 'x',
    });
    expect(out).toContain('(empty diff');
  });

  it('renders a no-assertions placeholder', () => {
    const out = buildAdversarialPrompt({
      diff: 'd',
      assertions: [],
      featureTitle: 'F1',
      acceptanceCriteria: 'x',
    });
    expect(out).toContain('(no structured assertions)');
  });
});

describe('createDefaultRunAgentCi', () => {
  const workflowsPresent = (): boolean => true;

  it('returns pass on exit 0', async () => {
    const ctx = makeStoreContext();
    await seedLeafTask(ctx, '/repo/.worktrees/feat-x');
    const runner = createDefaultRunAgentCi({
      hasAgentCiWorkflowsFn: workflowsPresent,
      spawnFn: () =>
        makeFakeChild({
          exitCode: 0,
          stdout: 'all checks passed',
        }),
    });
    const out = await runner({
      cwd: '/repo/.worktrees/feat-x',
      maxOutputBytes: 4_096,
    });
    expect(out.status).toBe('pass');
    expect(out.summary).toContain('all checks passed');
    expect(out.missing).toBe(false);
  });

  it('returns fail on non-zero exit', async () => {
    const runner = createDefaultRunAgentCi({
      hasAgentCiWorkflowsFn: workflowsPresent,
      spawnFn: () =>
        makeFakeChild({
          exitCode: 1,
          stderr: 'lint:error',
        }),
    });
    const out = await runner({
      cwd: '/x',
      maxOutputBytes: 4_096,
    });
    expect(out.status).toBe('fail');
    expect(out.summary).toContain('lint:error');
  });

  it('returns skipped when binary spawn throws ENOENT', async () => {
    const enoent = Object.assign(new Error('spawn npx ENOENT'), {
      code: 'ENOENT',
    });
    const runner = createDefaultRunAgentCi({
      hasAgentCiWorkflowsFn: workflowsPresent,
      spawnFn: () => {
        throw enoent;
      },
    });
    const out = await runner({
      cwd: '/x',
      maxOutputBytes: 4_096,
    });
    expect(out.status).toBe('skipped');
    expect(out.missing).toBe(true);
    expect(out.summary).toContain('binary not found');
  });

  it('returns error for non-ENOENT spawn errors', async () => {
    const runner = createDefaultRunAgentCi({
      hasAgentCiWorkflowsFn: workflowsPresent,
      spawnFn: () => {
        throw new Error('EACCES');
      },
    });
    const out = await runner({
      cwd: '/x',
      maxOutputBytes: 4_096,
    });
    expect(out.status).toBe('error');
    expect(out.missing).toBe(false);
  });

  it('returns error when killed by signal (exitCode null without spawnError)', async () => {
    const runner = createDefaultRunAgentCi({
      hasAgentCiWorkflowsFn: workflowsPresent,
      spawnFn: () =>
        makeFakeChild({
          exitCode: null,
        }),
    });
    const out = await runner({
      cwd: '/x',
      maxOutputBytes: 4_096,
    });
    expect(out.status).toBe('error');
    expect(out.summary).toContain('signal');
  });

  it('returns skipped (without invoking spawn) when no workflow files exist', async () => {
    let spawnCalled = false;
    const runner = createDefaultRunAgentCi({
      hasAgentCiWorkflowsFn: () => false,
      spawnFn: () => {
        spawnCalled = true;
        return makeFakeChild({
          exitCode: 0,
        });
      },
    });
    const out = await runner({
      cwd: '/x',
      maxOutputBytes: 4_096,
    });
    expect(out.status).toBe('skipped');
    expect(out.missing).toBe(true);
    expect(out.summary).toContain('no workflow files');
    expect(spawnCalled).toBe(false);
  });
});
