import { describe, expect, it } from 'bun:test';
import { HierarchyStatus } from '@noetic-tools/code-agent/tasks/schema';
import { loadTask } from '@noetic-tools/code-agent/tasks/store/fs-node';
import { planTaskHandler } from '../../../src/tasks/runtime/handlers/autopilot.js';
import { createTaskHandler } from '../../../src/tasks/runtime/handlers/lifecycle.js';
import {
  listInterviewSessions,
  listMilestones,
} from '../../../src/tasks/runtime/hierarchy/store.js';
import { makeStoreContext } from '../_helpers.js';

describe('planTaskHandler', () => {
  it('persists a hierarchy and flips status to active on a complete interview', async () => {
    const ctx = makeStoreContext();
    const task = await createTaskHandler(ctx, {
      title: 'Plan target',
    });
    const result = await planTaskHandler(ctx, {
      taskId: task.task.id,
      runInterview: async () => ({
        status: 'complete',
        envelope: {
          milestones: [
            {
              title: 'M1',
              description: null,
              verification: 'verify',
              slices: [
                {
                  title: 'S1',
                  description: null,
                  verification: 'v',
                  features: [
                    {
                      title: 'F1',
                      description: null,
                      acceptanceCriteria: 'ac',
                    },
                  ],
                },
              ],
              assertions: [],
            },
          ],
        },
      }),
    });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') {
      throw new Error('expected complete');
    }
    expect(result.task.hierarchyStatus).toBe(HierarchyStatus.Active);

    const reloaded = await loadTask(ctx, task.task.id);
    expect(reloaded.hierarchyStatus).toBe(HierarchyStatus.Active);

    const ms = await listMilestones(ctx, task.task.id);
    expect(ms.length).toBe(1);

    const sessions = await listInterviewSessions(ctx, task.task.id);
    expect(sessions.length).toBe(1);
    expect(sessions[0]?.status).toBe('complete');
  });

  it('returns incomplete when the interview hits maxQuestions', async () => {
    const ctx = makeStoreContext();
    const task = await createTaskHandler(ctx, {
      title: 'Cap',
    });
    const result = await planTaskHandler(ctx, {
      taskId: task.task.id,
      runInterview: async () => ({
        status: 'maxQuestions',
        reason: 'hit budget',
      }),
    });
    expect(result.status).toBe('incomplete');
    expect(result.task.hierarchyStatus).toBe(HierarchyStatus.Planning);

    const sessions = await listInterviewSessions(ctx, task.task.id);
    expect(sessions[0]?.status).toBe('cancelled');
  });

  it('throws on missing task', async () => {
    const ctx = makeStoreContext();
    await expect(
      planTaskHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
        runInterview: async () => ({
          status: 'maxQuestions',
        }),
      }),
    ).rejects.toThrow();
  });
});
