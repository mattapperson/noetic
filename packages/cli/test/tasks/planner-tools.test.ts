/**
 * Tool-level tests for the planner's terminal tools.
 *
 * These tests exercise the same commit / state / event paths the old
 * `runPlanner` step-graph tests covered, but at the tool boundary so they
 * don't need to spin up an `AgentHarness`. The runner glue (signal wiring,
 * harness construction, prompt assembly) is exercised by an integration
 * test once the IPC server is wired up; here we just validate that calling
 * either terminal tool produces the right side effects.
 */

import { describe, expect, it } from 'bun:test';
import {
  AutopilotState,
  EventKind,
  HierarchyStatus,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic/code-agent/tasks/schema';
import { saveTask, tailEvents, tryLoadTask } from '@noetic/code-agent/tasks/store/fs-node';
import type { ToolExecutionContext } from '@noetic-tools/core';
import { createDetachedSignal } from '@noetic-tools/core';
import { listMilestones } from '../../src/tasks/runtime/hierarchy/store.js';
import type { PlannerOutcome } from '../../src/tasks/runtime/planner-tools.js';
import {
  createAbandonPlanningTool,
  createSubmitHierarchyTool,
} from '../../src/tasks/runtime/planner-tools.js';
import { makeStoreContext } from './_helpers.js';

const TASK_ID = 'T-plan000000';

/**
 * Empty stub that satisfies `ToolExecutionContext`'s shape at the type
 * boundary. Terminal tools never read this value — they close over the
 * deps passed to their factory — so the structural empty object is
 * deliberate, not a workaround.
 */
function stubExecutionContext(): ToolExecutionContext {
  const empty: ToolExecutionContext = Object.create(null);
  return empty;
}

async function seedManualTask(ctx: ReturnType<typeof makeStoreContext>): Promise<void> {
  const now = '2026-05-01T00:00:00.000Z';
  await saveTask(ctx, {
    id: TASK_ID,
    source: TaskSource.Manual,
    title: 'Implement hello-qa script',
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
    autopilotState: AutopilotState.Planning,
    lastAutopilotActivityAt: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
}

const HIERARCHY = {
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
      assertions: [
        {
          title: 'A1',
          assertion: 'X is true',
          featureIndices: [
            0,
          ],
        },
      ],
    },
  ],
};

describe('planner-tools', () => {
  describe('submit_hierarchy', () => {
    it('persists the hierarchy, flips hierarchyStatus to Active, resolves the signal', async () => {
      const ctx = makeStoreContext();
      await seedManualTask(ctx);
      const signal = createDetachedSignal<PlannerOutcome>();
      const tool = createSubmitHierarchyTool({
        storeCtx: ctx,
        taskId: TASK_ID,
        signal,
      });

      const args = tool.input.parse(HIERARCHY);
      const out = await tool.execute(args, stubExecutionContext());
      expect(out).toEqual({
        status: 'committed',
        milestoneCount: 1,
      });

      const task = await tryLoadTask(ctx, TASK_ID);
      expect(task?.hierarchyStatus).toBe(HierarchyStatus.Active);
      expect(task?.autopilotState).toBe(AutopilotState.Watching);

      const milestones = await listMilestones(ctx, TASK_ID);
      expect(milestones.length).toBe(1);

      const events = await tailEvents(ctx);
      const hierarchyEvents = events.filter((e) => e.kind === EventKind.HierarchyStatusChanged);
      expect(hierarchyEvents.length).toBe(1);
      expect(hierarchyEvents[0]?.payload?.hierarchyStatus).toBe(HierarchyStatus.Active);

      const outcome = await signal.done;
      expect(outcome.status).toBe('completed');
      if (outcome.status === 'completed') {
        expect(outcome.hierarchy.milestones.length).toBe(1);
      }
    });

    it('rejects an empty milestones array', () => {
      const ctx = makeStoreContext();
      const signal = createDetachedSignal<PlannerOutcome>();
      const tool = createSubmitHierarchyTool({
        storeCtx: ctx,
        taskId: TASK_ID,
        signal,
      });
      expect(() =>
        tool.input.parse({
          milestones: [],
        }),
      ).toThrow();
    });
  });

  describe('abandon_planning', () => {
    it('writes a failure log + event and resolves the signal as failed', async () => {
      const ctx = makeStoreContext();
      await seedManualTask(ctx);
      const signal = createDetachedSignal<PlannerOutcome>();
      const tool = createAbandonPlanningTool({
        storeCtx: ctx,
        taskId: TASK_ID,
        signal,
      });

      const args = tool.input.parse({
        reason: 'task description too thin to plan',
      });
      const out = await tool.execute(args, stubExecutionContext());
      expect(out).toEqual({
        status: 'abandoned',
      });

      const task = await tryLoadTask(ctx, TASK_ID);
      expect(task?.autopilotState).toBe(AutopilotState.Inactive);
      expect(task?.hierarchyStatus).toBeNull();

      const events = await tailEvents(ctx);
      const exitEvent = events.find(
        (e) =>
          e.kind === EventKind.TaskUpdated && e.taskId === TASK_ID && e.payload?.phase === 'exit',
      );
      expect(exitEvent?.payload?.plannerStatus).toBe('failed');

      const outcome = await signal.done;
      expect(outcome.status).toBe('failed');
      if (outcome.status === 'failed') {
        expect(outcome.reason).toBe('task description too thin to plan');
      }
    });

    it('rejects an empty reason', () => {
      const ctx = makeStoreContext();
      const signal = createDetachedSignal<PlannerOutcome>();
      const tool = createAbandonPlanningTool({
        storeCtx: ctx,
        taskId: TASK_ID,
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
