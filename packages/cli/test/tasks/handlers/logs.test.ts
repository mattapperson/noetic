import { describe, expect, it } from 'bun:test';
import {
  logsTaskHandler,
  logTaskHandler,
} from '../../../src/commands/builtins/tasks/handlers/inspection.js';
import { createTaskHandler } from '../../../src/commands/builtins/tasks/handlers/lifecycle.js';
import { makeStoreContext } from '../_helpers.js';

describe('logsTaskHandler', () => {
  it('returns the trailing N entries', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Logs',
    });
    for (let i = 0; i < 4; i++) {
      await logTaskHandler(ctx, {
        taskId: created.task.id,
        message: `entry ${i}`,
      });
    }
    const result = await logsTaskHandler(ctx, {
      taskId: created.task.id,
      n: 2,
    });
    expect(result.entries.length).toBe(2);
    expect(result.entries[1]?.message).toBe('entry 3');
  });

  it('throws when the task is missing', async () => {
    const ctx = makeStoreContext();
    await expect(
      logsTaskHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
      }),
    ).rejects.toThrow();
  });
});
