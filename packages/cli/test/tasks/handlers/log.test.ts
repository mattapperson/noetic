import { describe, expect, it } from 'bun:test';

import { readLog } from '@noetic/code-agent/tasks/store/fs-node';
import { createTaskHandler } from '../../../src/commands/builtins/tasks/handlers/create.js';
import { logTaskHandler } from '../../../src/commands/builtins/tasks/handlers/log.js';
import { LogEntryKind } from '@noetic/code-agent/tasks/schema';
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
