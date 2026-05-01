import { describe, expect, it } from 'bun:test';

import { saveTask, tailEvents, tryLoadTask } from '../../src/commands/builtins/tasks/fs-store.js';
import { listMilestones } from '../../src/commands/builtins/tasks/hierarchy/store.js';
import type { RunPlannerInterviewFn } from '../../src/commands/builtins/tasks/planner-runner.js';
import { runPlanner } from '../../src/commands/builtins/tasks/planner-runner.js';
import { loadPlanner, savePlanner } from '../../src/commands/builtins/tasks/planner-state.js';
import {
  AutopilotState,
  EventKind,
  HierarchyStatus,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '../../src/commands/builtins/tasks/schemas.js';
import { makeStoreContext } from './_helpers.js';

const TASK_ID = 'T-plan000000';

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
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: true,
    autopilotState: AutopilotState.Planning,
    lastAutopilotActivityAt: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
  await savePlanner(ctx, {
    taskId: TASK_ID,
    sessionId: 'S-test',
    pid: 4242,
    pidStarttime: null,
    startedAt: now,
    pausedAt: null,
  });
}

const completedInterviewFn: RunPlannerInterviewFn = async () => ({
  status: 'completed',
  hierarchy: {
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
  },
});

const failedInterviewFn: RunPlannerInterviewFn = async () => ({
  status: 'failed',
  reason: 'LLM rejected the task as ambiguous',
});

const maxQuestionsInterviewFn: RunPlannerInterviewFn = async () => ({
  status: 'maxQuestions',
  reason: 'budget exhausted',
});

describe('runPlanner', () => {
  it('persists the hierarchy and flips hierarchyStatus to active on completed outcome', async () => {
    const ctx = makeStoreContext();
    await seedManualTask(ctx);
    const result = await runPlanner({
      ctx,
      taskDir: `${ctx.projectRoot}/.noetic/tasks/${TASK_ID}`,
      runInterviewFn: completedInterviewFn,
    });
    expect(result.outcome.status).toBe('completed');
    const task = await tryLoadTask(ctx, TASK_ID);
    expect(task?.hierarchyStatus).toBe(HierarchyStatus.Active);
    expect(task?.autopilotState).toBe(AutopilotState.Watching);
    const milestones = await listMilestones(ctx, TASK_ID);
    expect(milestones.length).toBe(1);
    const events = await tailEvents(ctx);
    const missionEvents = events.filter((e) => e.kind === EventKind.HierarchyStatusChanged);
    expect(missionEvents.length).toBe(1);
    expect(missionEvents[0]?.payload?.hierarchyStatus).toBe(HierarchyStatus.Active);
    expect(await loadPlanner(ctx, TASK_ID)).toBeNull();
  });

  it('flips autopilotState back to inactive on failed outcome', async () => {
    const ctx = makeStoreContext();
    await seedManualTask(ctx);
    const result = await runPlanner({
      ctx,
      taskDir: `${ctx.projectRoot}/.noetic/tasks/${TASK_ID}`,
      runInterviewFn: failedInterviewFn,
    });
    expect(result.outcome.status).toBe('failed');
    const task = await tryLoadTask(ctx, TASK_ID);
    expect(task?.autopilotState).toBe(AutopilotState.Inactive);
    expect(task?.hierarchyStatus).toBeNull();
    const milestones = await listMilestones(ctx, TASK_ID);
    expect(milestones.length).toBe(0);
    expect(await loadPlanner(ctx, TASK_ID)).toBeNull();
    const events = await tailEvents(ctx);
    const exitEvents = events.filter(
      (e) =>
        e.kind === EventKind.TaskUpdated && e.taskId === TASK_ID && e.payload?.phase === 'exit',
    );
    expect(exitEvents.length).toBe(1);
    expect(exitEvents[0]?.payload?.plannerStatus).toBe('failed');
    expect(exitEvents[0]?.payload?.autopilotState).toBe(AutopilotState.Inactive);
  });

  it('flips autopilotState to inactive on maxQuestions outcome', async () => {
    const ctx = makeStoreContext();
    await seedManualTask(ctx);
    const result = await runPlanner({
      ctx,
      taskDir: `${ctx.projectRoot}/.noetic/tasks/${TASK_ID}`,
      runInterviewFn: maxQuestionsInterviewFn,
    });
    expect(result.outcome.status).toBe('maxQuestions');
    const task = await tryLoadTask(ctx, TASK_ID);
    expect(task?.autopilotState).toBe(AutopilotState.Inactive);
    const events = await tailEvents(ctx);
    const exitEvent = events.find(
      (e) =>
        e.kind === EventKind.TaskUpdated && e.taskId === TASK_ID && e.payload?.phase === 'exit',
    );
    expect(exitEvent?.payload?.plannerStatus).toBe('maxQuestions');
  });

  it('refuses to overwrite a task that already has a hierarchy', async () => {
    const ctx = makeStoreContext();
    await seedManualTask(ctx);
    // Seed a hierarchy via the completed interview path first.
    await runPlanner({
      ctx,
      taskDir: `${ctx.projectRoot}/.noetic/tasks/${TASK_ID}`,
      runInterviewFn: completedInterviewFn,
    });
    // Re-attempt — runner should refuse to overwrite.
    let interviewCalls = 0;
    const result = await runPlanner({
      ctx,
      taskDir: `${ctx.projectRoot}/.noetic/tasks/${TASK_ID}`,
      runInterviewFn: async () => {
        interviewCalls += 1;
        return {
          status: 'completed',
          hierarchy: {
            milestones: [],
          },
        };
      },
    });
    expect(result.outcome.status).toBe('failed');
    expect(interviewCalls).toBe(0);
  });

  it('throws when NOETIC_TASK_DIR is missing', async () => {
    await expect(runPlanner({})).rejects.toThrow(/NOETIC_TASK_DIR/);
  });

  it('passes description through to the interview function', async () => {
    const ctx = makeStoreContext();
    await seedManualTask(ctx);
    // Drop a description.md file.
    await ctx.fs.mkdir(`${ctx.projectRoot}/.noetic/tasks/${TASK_ID}`);
    await ctx.fs.writeFile(
      `${ctx.projectRoot}/.noetic/tasks/${TASK_ID}/description.md`,
      'Add scripts/qa-hello.ts that prints hello QA',
    );
    let receivedDescription = '';
    const captureInterview: RunPlannerInterviewFn = async (args) => {
      receivedDescription = args.description;
      return {
        status: 'completed',
        hierarchy: {
          milestones: [],
        },
      };
    };
    await runPlanner({
      ctx,
      taskDir: `${ctx.projectRoot}/.noetic/tasks/${TASK_ID}`,
      runInterviewFn: captureInterview,
    });
    expect(receivedDescription).toBe('Add scripts/qa-hello.ts that prints hello QA');
  });
});
