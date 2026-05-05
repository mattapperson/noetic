/**
 * Tool-level tests for the implementer's terminal tools.
 *
 * Mirrors the planner-tools tests: exercise the commit / state / event
 * paths at the tool boundary, no AgentHarness needed. The runner glue
 * is exercised by an end-to-end test once the IPC server is wired up.
 */

import { describe, expect, it } from 'bun:test';

import type { ToolExecutionContext } from '@noetic/core';
import { createDetachedSignal } from '@noetic/core';
import { saveTask, tailEvents } from '@noetic/code-agent/tasks/store/fs-node';
import type { ImplementerOutcome } from '../../src/commands/builtins/tasks/hierarchy/implementer-flow.js';
import { persistTaskHierarchy } from '../../src/commands/builtins/tasks/hierarchy/persist.js';
import { FeatureLoopState } from '../../src/commands/builtins/tasks/hierarchy/schemas.js';
import { loadFeature } from '../../src/commands/builtins/tasks/hierarchy/store.js';
import {
  createImplementationBlockedTool,
  createImplementationDoneTool,
} from '../../src/commands/builtins/tasks/implementer-tools.js';
import {
  AutopilotState,
  EventKind,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic/code-agent/tasks/schema';
import { makeStoreContext } from './_helpers.js';

const PARENT_ID = 'T-parent0000';
const LEAF_ID = 'T-leaf000000';

function stubExecutionContext(): ToolExecutionContext {
  const empty: ToolExecutionContext = Object.create(null);
  return empty;
}

async function seedTasksAndHierarchy(ctx: ReturnType<typeof makeStoreContext>): Promise<{
  featureId: string;
}> {
  const now = '2026-05-01T00:00:00.000Z';
  await saveTask(ctx, {
    id: PARENT_ID,
    source: TaskSource.Manual,
    title: 'parent',
    projectRoot: ctx.projectRoot,
    worktreePath: null,
    branch: null,
    headSha: null,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: true,
    autopilotState: AutopilotState.Watching,
    lastAutopilotActivityAt: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
  await saveTask(ctx, {
    id: LEAF_ID,
    source: TaskSource.Worktree,
    title: 'leaf',
    projectRoot: ctx.projectRoot,
    worktreePath: '/repo/.worktrees/feat-x',
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
  const persisted = await persistTaskHierarchy(ctx, PARENT_ID, {
    milestones: [
      {
        title: 'M1',
        verification: 'tests pass',
        slices: [
          {
            title: 'S1',
            verification: 'visible',
            features: [
              {
                title: 'F1',
                acceptanceCriteria: 'user can do X',
              },
            ],
          },
        ],
        assertions: [],
      },
    ],
  });
  const featureId = persisted.features[0]?.id;
  if (featureId === undefined) {
    throw new Error('failed to seed feature');
  }
  return {
    featureId,
  };
}

describe('implementer-tools', () => {
  describe('signal_implementation_done', () => {
    it('flips the parent feature to Validating and resolves the signal as completed', async () => {
      const ctx = makeStoreContext();
      const { featureId } = await seedTasksAndHierarchy(ctx);
      const signal = createDetachedSignal<ImplementerOutcome>();
      const tool = createImplementationDoneTool({
        storeCtx: ctx,
        leafTaskId: LEAF_ID,
        parentTaskId: PARENT_ID,
        featureId,
        signal,
      });

      const args = tool.input.parse({
        summary: 'wired up the new endpoint and added tests',
      });
      const out = await tool.execute(args, stubExecutionContext());
      expect(out).toEqual({
        status: 'completed',
      });

      const feature = await loadFeature(ctx, PARENT_ID, featureId);
      expect(feature?.loopState).toBe(FeatureLoopState.Validating);

      const events = await tailEvents(ctx);
      const stateEvents = events.filter((e) => e.kind === EventKind.FeatureLoopStateChanged);
      expect(stateEvents.length).toBe(1);
      expect(stateEvents[0]?.payload?.loopState).toBe(FeatureLoopState.Validating);
      expect(stateEvents[0]?.payload?.phase).toBe('exit');

      const outcome = await signal.done;
      expect(outcome.status).toBe('completed');
      expect(outcome.summary).toBe('wired up the new endpoint and added tests');
    });

    it('rejects an empty summary', () => {
      const ctx = makeStoreContext();
      const signal = createDetachedSignal<ImplementerOutcome>();
      const tool = createImplementationDoneTool({
        storeCtx: ctx,
        leafTaskId: LEAF_ID,
        parentTaskId: PARENT_ID,
        featureId: 'F-x',
        signal,
      });
      expect(() =>
        tool.input.parse({
          summary: '',
        }),
      ).toThrow();
    });
  });

  describe('signal_implementation_blocked', () => {
    it('flips the parent feature to Blocked and resolves the signal as blocked', async () => {
      const ctx = makeStoreContext();
      const { featureId } = await seedTasksAndHierarchy(ctx);
      const signal = createDetachedSignal<ImplementerOutcome>();
      const tool = createImplementationBlockedTool({
        storeCtx: ctx,
        leafTaskId: LEAF_ID,
        parentTaskId: PARENT_ID,
        featureId,
        signal,
      });

      const args = tool.input.parse({
        reason: 'cannot reproduce the bug locally',
      });
      const out = await tool.execute(args, stubExecutionContext());
      expect(out).toEqual({
        status: 'blocked',
      });

      const feature = await loadFeature(ctx, PARENT_ID, featureId);
      expect(feature?.loopState).toBe(FeatureLoopState.Blocked);

      const outcome = await signal.done;
      expect(outcome.status).toBe('blocked');
      expect(outcome.summary).toBe('cannot reproduce the bug locally');
      expect(outcome.blockedReason).toBe('cannot reproduce the bug locally');
    });

    it('rejects an empty reason', () => {
      const ctx = makeStoreContext();
      const signal = createDetachedSignal<ImplementerOutcome>();
      const tool = createImplementationBlockedTool({
        storeCtx: ctx,
        leafTaskId: LEAF_ID,
        parentTaskId: PARENT_ID,
        featureId: 'F-x',
        signal,
      });
      expect(() =>
        tool.input.parse({
          reason: '',
        }),
      ).toThrow();
    });
  });
});
