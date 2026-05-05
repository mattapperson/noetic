import { describe, expect, it } from 'bun:test';

import { AgentHarness } from '@noetic/core';

import { loadTask, saveTask } from '@noetic/code-agent/tasks/store/fs-node';
import {
  buildReconcileEvery,
  buildReconcileTickStep,
} from '../../../src/commands/builtins/tasks/hierarchy/reconcile-flow.js';
import type { Task } from '@noetic/code-agent/tasks/schema';
import {
  AutopilotState,
  generateTaskId,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic/code-agent/tasks/schema';
import { makeStoreContext } from '../_helpers.js';

const NOW = '2026-04-30T00:00:00.000Z';

//#region Helpers

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? generateTaskId(),
    source: TaskSource.Worktree,
    title: 't',
    projectRoot: '/repo',
    worktreePath: '/repo/.worktrees/foo',
    branch: 'feat/foo',
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
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

function makeHarness(fs: ReturnType<typeof makeStoreContext>['fs']): AgentHarness {
  return new AgentHarness({
    name: 'reconcile-flow-test',
    params: {},
    fs,
  });
}

//#endregion

//#region Tests

describe('reconcileTickStep (driven by harness.run)', () => {
  it('returns an empty result when there are no tasks', async () => {
    const ctx = makeStoreContext();
    const harness = makeHarness(ctx.fs);
    const childCtx = harness.createContext();

    const tickStep = buildReconcileTickStep({
      ctx,
      loadWorktrees: async () => [],
    });
    const result = await harness.run(tickStep, undefined, childCtx);
    expect(result.markedRemoved).toEqual([]);
  });

  it('leaves manual-source tasks alone even when worktree is missing', async () => {
    const ctx = makeStoreContext();
    const manual = makeTask({
      source: TaskSource.Manual,
      worktreePath: null,
    });
    await saveTask(ctx, manual);
    const harness = makeHarness(ctx.fs);
    const childCtx = harness.createContext();

    const tickStep = buildReconcileTickStep({
      ctx,
      loadWorktrees: async () => [],
    });
    const result = await harness.run(tickStep, undefined, childCtx);
    expect(result.markedRemoved).toHaveLength(0);
    const reloaded = await loadTask(ctx, manual.id);
    expect(reloaded.lifecycleStatus).toBe(TaskLifecycleStatus.Active);
  });

  it('leaves merged/cleanup-blocked terminal tasks alone', async () => {
    const ctx = makeStoreContext();
    const merged = makeTask({
      lifecycleStatus: TaskLifecycleStatus.Merged,
    });
    const cleanupBlocked = makeTask({
      lifecycleStatus: TaskLifecycleStatus.CleanupBlocked,
    });
    await saveTask(ctx, merged);
    await saveTask(ctx, cleanupBlocked);
    const harness = makeHarness(ctx.fs);
    const childCtx = harness.createContext();

    const tickStep = buildReconcileTickStep({
      ctx,
      loadWorktrees: async () => [],
    });
    const result = await harness.run(tickStep, undefined, childCtx);
    expect(result.markedRemoved).toHaveLength(0);
  });
});

describe('reconcileTickStep (vanished worktree)', () => {
  it('marks worktree-source tasks whose path is missing as removed', async () => {
    const ctx = makeStoreContext();
    const stale = makeTask({
      worktreePath: '/repo/.worktrees/gone',
    });
    const live = makeTask({
      worktreePath: '/repo/.worktrees/here',
    });
    await saveTask(ctx, stale);
    await saveTask(ctx, live);
    const harness = makeHarness(ctx.fs);
    const childCtx = harness.createContext();

    const tickStep = buildReconcileTickStep({
      ctx,
      loadWorktrees: async () => [
        {
          projectRoot: '/repo',
          path: '/repo/.worktrees/here',
          branch: 'feat/foo',
          headSha: null,
          current: false,
        },
      ],
    });
    const result = await harness.run(tickStep, undefined, childCtx);
    expect(result.markedRemoved).toHaveLength(1);
    expect(result.markedRemoved[0]?.id).toBe(stale.id);
    const reloaded = await loadTask(ctx, stale.id);
    expect(reloaded.lifecycleStatus).toBe(TaskLifecycleStatus.Removed);
    const reloadedLive = await loadTask(ctx, live.id);
    expect(reloadedLive.lifecycleStatus).toBe(TaskLifecycleStatus.Active);
  });
});

describe('buildReconcileEvery', () => {
  it('returns a StepEvery wrapping the tick step', () => {
    const ctx = makeStoreContext();
    const everyStep = buildReconcileEvery({
      ctx,
    });
    expect(everyStep.kind).toBe('every');
    expect(everyStep.id).toBe('reconcile.every');
    expect(everyStep.ms).toBe(60_000);
    expect(everyStep.onError).toBe('continue');
    // Body step has stable id for trace correlation. Wrapped in a void
    // adapter so the daemon-fork's path types stay uniform `Step<void, void>`.
    expect(everyStep.step.id).toBe('reconcile.tick.void');
  });

  it('void wrapper actually invokes the inner tick (loadWorktrees observed, mark-removed visible)', async () => {
    // Catches a wrapper-only refactor where the void adapter never
    // calls `harness.run(inner, ...)`. The .void id check above would
    // still pass in that regression.
    const ctx = makeStoreContext();
    const stale = makeTask({
      worktreePath: '/repo/.worktrees/gone',
    });
    await saveTask(ctx, stale);

    let loadCalls = 0;
    const everyStep = buildReconcileEvery({
      ctx,
      loadWorktrees: async () => {
        loadCalls += 1;
        return [];
      },
    });
    const harness = makeHarness(ctx.fs);
    const childCtx = harness.createContext();
    await harness.run(everyStep.step, undefined, childCtx);

    expect(loadCalls).toBe(1);
    const reloaded = await loadTask(ctx, stale.id);
    expect(reloaded.lifecycleStatus).toBe(TaskLifecycleStatus.Removed);
  });
});

//#endregion
