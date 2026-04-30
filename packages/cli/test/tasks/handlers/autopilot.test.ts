import { describe, expect, it } from 'bun:test';

import { loadTask } from '../../../src/commands/builtins/tasks/fs-store.js';
import { autopilotHandler } from '../../../src/commands/builtins/tasks/handlers/autopilot.js';
import { createTaskHandler } from '../../../src/commands/builtins/tasks/handlers/create.js';
import { AutopilotState } from '../../../src/commands/builtins/tasks/schemas.js';
import { makeStoreContext } from '../_helpers.js';

describe('autopilotHandler', () => {
  it('enables autopilot and moves state to watching', async () => {
    const ctx = makeStoreContext();
    const task = await createTaskHandler(ctx, {
      title: 'Toggle',
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
    await autopilotHandler(ctx, {
      taskId: task.task.id,
      enabled: true,
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
      enabled: false,
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
