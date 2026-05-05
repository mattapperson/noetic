import { describe, expect, it } from 'bun:test';

import { readLog } from '@noetic/code-agent/tasks/store/fs-node';
import { commentTaskHandler } from '../../../src/commands/builtins/tasks/handlers/comment.js';
import { createTaskHandler } from '../../../src/commands/builtins/tasks/handlers/create.js';
import { LogEntryKind } from '@noetic/code-agent/tasks/schema';
import { makeStoreContext } from '../_helpers.js';

describe('commentTaskHandler', () => {
  it('appends a comment-kind entry', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Comment target',
    });
    const result = await commentTaskHandler(ctx, {
      taskId: created.task.id,
      message: 'looks good',
    });
    expect(result.entry.kind).toBe(LogEntryKind.Comment);

    const log = await readLog(ctx, created.task.id);
    expect(log.length).toBe(1);
    expect(log[0]?.message).toBe('looks good');
  });

  it('rejects empty messages', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Empty',
    });
    await expect(
      commentTaskHandler(ctx, {
        taskId: created.task.id,
        message: '   ',
      }),
    ).rejects.toThrow(/empty/);
  });
});
