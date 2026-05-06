import { describe, expect, it } from 'bun:test';
import { LogEntryKind } from '@noetic/code-agent/tasks/schema';
import { readLog } from '@noetic/code-agent/tasks/store/fs-node';
import { logTaskHandler } from '../../../src/tasks/runtime/handlers/inspection.js';
import { createTaskHandler } from '../../../src/tasks/runtime/handlers/lifecycle.js';
import { makeStoreContext } from '../_helpers.js';

describe('logTaskHandler', () => {
  it('appends a log entry observable via readLog', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Log target',
    });
    const result = await logTaskHandler(ctx, {
      taskId: created.task.id,
      message: 'started agent-ci',
    });
    expect(result.entry.kind).toBe(LogEntryKind.Log);

    const entries = await readLog(ctx, created.task.id);
    expect(entries.length).toBe(1);
    expect(entries[0]?.message).toBe('started agent-ci');
  });

  it('throws when the task does not exist', async () => {
    const ctx = makeStoreContext();
    await expect(
      logTaskHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
        message: 'noop',
      }),
    ).rejects.toThrow();
  });
});
