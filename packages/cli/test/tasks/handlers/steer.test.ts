import { describe, expect, it } from 'bun:test';

import { readLog } from '@noetic/code-agent/tasks/store/fs-node';
import { createTaskHandler } from '../../../src/commands/builtins/tasks/handlers/create.js';
import { steerTaskHandler } from '../../../src/commands/builtins/tasks/handlers/steer.js';
import { taskDirPaths } from '@noetic/code-agent/tasks/store/fs-node';
import { LogEntryKind } from '@noetic/code-agent/tasks/schema';
import { makeStoreContext } from '../_helpers.js';

describe('steerTaskHandler', () => {
  it('logs and writes to steering.md', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Steer target',
    });

    await steerTaskHandler(ctx, {
      taskId: created.task.id,
      message: 'prefer functional style',
    });
    await steerTaskHandler(ctx, {
      taskId: created.task.id,
      message: 'avoid React refs',
    });

    const log = await readLog(ctx, created.task.id);
    expect(log.length).toBe(2);
    expect(log[0]?.kind).toBe(LogEntryKind.Steer);

    const paths = taskDirPaths(ctx, created.task.id);
    const steering = await ctx.fs.readFileText(paths.steering);
    expect(steering).toContain('prefer functional style');
    expect(steering).toContain('avoid React refs');
  });

  it('rejects empty steering messages', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Empty steer',
    });
    await expect(
      steerTaskHandler(ctx, {
        taskId: created.task.id,
        message: '   ',
      }),
    ).rejects.toThrow(/empty/);
  });
});
