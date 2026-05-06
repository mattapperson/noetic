import { describe, expect, it } from 'bun:test';
import { AutopilotState } from '@noetic/code-agent/tasks/schema';
import { loadTask } from '@noetic/code-agent/tasks/store/fs-node';
import { autopilotHandler } from '../../../src/tasks/runtime/handlers/autopilot.js';
import { createTaskHandler } from '../../../src/tasks/runtime/handlers/lifecycle.js';
import { makeStoreContext } from '../_helpers.js';

describe('autopilotHandler', () => {
  it('enables autopilot and moves state to watching', async () => {
    const ctx = makeStoreContext();
    const task = await createTaskHandler(ctx, {
      title: 'Toggle',
    });
    await autopilotHandler(ctx, {
      taskId: task.task.id,
      enabled: false,
    });
    const result = await autopilotHandler(ctx, {
      taskId: task.task.id,
      enabled: true,
    });
    expect(result.task.autopilotEnabled).toBe(true);
    expect(result.task.autopilotState).toBe(AutopilotState.Watching);
    expect(result.previousEnabled).toBe(false);

    const reloaded = await loadTask(ctx, task.task.id);
    expect(reloaded.autopilotEnabled).toBe(true);
  });

  it('disabling resets autopilot state to inactive', async () => {
    const ctx = makeStoreContext();
    const task = await createTaskHandler(ctx, {
      title: 'Disable',
    });
    const result = await autopilotHandler(ctx, {
      taskId: task.task.id,
      enabled: false,
    });
    expect(result.task.autopilotEnabled).toBe(false);
    expect(result.task.autopilotState).toBe(AutopilotState.Inactive);
  });

  it('is a no-op when toggling matches the existing state', async () => {
    const ctx = makeStoreContext();
    const task = await createTaskHandler(ctx, {
      title: 'Noop',
    });
    const result = await autopilotHandler(ctx, {
      taskId: task.task.id,
      enabled: true,
    });
    expect(result.task).toEqual(task.task);
  });

  it('throws on missing task', async () => {
    const ctx = makeStoreContext();
    await expect(
      autopilotHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
        enabled: true,
      }),
    ).rejects.toThrow();
  });
});
