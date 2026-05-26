import { describe, expect, it } from 'bun:test';
import { LogEntryKind } from '@noetic/code-agent/tasks/schema';
import { appendLog } from '@noetic/code-agent/tasks/store/fs-node';
import { showTaskHandler } from '../../../src/tasks/runtime/handlers/inspection.js';
import { createTaskHandler } from '../../../src/tasks/runtime/handlers/lifecycle.js';
import { makeStoreContext } from '../_helpers.js';

describe('showTaskHandler', () => {
  it('returns the task with empty hierarchy and recent log', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Show me',
    });
    await appendLog(ctx, {
      taskId: created.task.id,
      entry: {
        kind: LogEntryKind.Log,
        ts: '2026-04-30T00:00:00.000Z',
        message: 'first log line',
      },
    });
    const result = await showTaskHandler(ctx, {
      taskId: created.task.id,
    });
    expect(result.task.id).toBe(created.task.id);
    expect(result.recentLog.length).toBe(1);
    expect(result.recentLog[0]?.message).toBe('first log line');
    expect(result.hierarchy).toBeNull();
  });

  it('throws when the task does not exist', async () => {
    const ctx = makeStoreContext();
    await expect(
      showTaskHandler(ctx, {
        taskId: 'T-zzzzzzzzzz',
      }),
    ).rejects.toThrow(/not found/);
  });

  it('respects the logTail cap', async () => {
    const ctx = makeStoreContext();
    const created = await createTaskHandler(ctx, {
      title: 'Cap test',
    });
    for (let i = 0; i < 5; i++) {
      await appendLog(ctx, {
        taskId: created.task.id,
        entry: {
          kind: LogEntryKind.Log,
          ts: `2026-04-30T00:00:0${i}.000Z`,
          message: `entry ${i}`,
        },
      });
    }
    const result = await showTaskHandler(ctx, {
      taskId: created.task.id,
      logTail: 2,
    });
    expect(result.recentLog.length).toBe(2);
    expect(result.recentLog[1]?.message).toBe('entry 4');
  });
});
