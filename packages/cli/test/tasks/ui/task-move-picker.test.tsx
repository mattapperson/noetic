/**
 * Coverage for the move-task path. Drives `commitMove` against the
 * in-memory store and asserts:
 *
 * 1. The task on disk is updated to the requested column.
 * 2. A `task:moved` event is appended with the new column in the payload.
 * 3. `clampCursor` clips bounds correctly across boundary inputs.
 */

import { describe, expect, test } from 'bun:test';

import { saveTask, tailEvents } from '../../../src/commands/builtins/tasks/fs-store.js';
import { KanbanColumn } from '../../../src/commands/builtins/tasks/kanban.js';
import type { Task } from '../../../src/commands/builtins/tasks/schemas.js';
import { TaskSource } from '../../../src/commands/builtins/tasks/schemas.js';
import {
  clampCursor,
  commitMove,
} from '../../../src/commands/builtins/tasks/ui/task-move-picker.js';
import { makeStoreContext } from '../_helpers.js';

//#region Fixtures

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id,
    source: TaskSource.Manual,
    title: id,
    projectRoot: '/repo',
    worktreePath: null,
    branch: null,
    headSha: null,
    reviewStatus: 'not_started',
    lifecycleStatus: 'active',
    paused: false,
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: false,
    autopilotState: 'inactive',
    lastAutopilotActivityAt: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

//#endregion

describe('clampCursor', () => {
  test('clips at lower bound', () => {
    expect(clampCursor(0, -1, 4)).toBe(0);
  });

  test('clips at upper bound', () => {
    expect(clampCursor(4, 1, 4)).toBe(4);
  });

  test('passes through within range', () => {
    expect(clampCursor(2, 1, 4)).toBe(3);
    expect(clampCursor(2, -1, 4)).toBe(1);
  });

  test('returns 0 when the column list is empty', () => {
    expect(clampCursor(0, 1, 0)).toBe(0);
  });
});

describe('commitMove', () => {
  test('moves a task to InProgress and appends task:moved with previousColumn', async () => {
    const ctx = makeStoreContext('/repo');
    const task = makeTask('T-aaaaaaaaaa');
    await saveTask(ctx, task);

    const next = await commitMove({
      ctx,
      taskId: task.id,
      column: KanbanColumn.InProgress,
    });
    expect(next.reviewStatus).toBe('reviewing');

    const events = await tailEvents(ctx);
    const moved = events.filter((e) => e.kind === 'task:moved');
    expect(moved).toHaveLength(1);
    expect(moved[0]?.taskId).toBe(task.id);
    expect(moved[0]?.payload?.column).toBe(KanbanColumn.InProgress);
    expect(moved[0]?.payload?.previousColumn).toBe(KanbanColumn.Triage);
  });

  test('moving to Archived stamps archivedAt', async () => {
    const ctx = makeStoreContext('/repo2');
    const task = makeTask('T-bbbbbbbbbb');
    await saveTask(ctx, task);
    const next = await commitMove({
      ctx,
      taskId: task.id,
      column: KanbanColumn.Archived,
    });
    expect(next.archivedAt).not.toBeNull();
  });

  test('moving to Done flips lifecycleStatus to merged', async () => {
    const ctx = makeStoreContext('/repo3');
    const task = makeTask('T-cccccccccc');
    await saveTask(ctx, task);
    const next = await commitMove({
      ctx,
      taskId: task.id,
      column: KanbanColumn.Done,
    });
    expect(next.lifecycleStatus).toBe('merged');
  });

  test('refuses to move into reconciler-owned column without force', async () => {
    const ctx = makeStoreContext('/repo4');
    const task = makeTask('T-dddddddddd');
    await saveTask(ctx, task);
    await expect(
      commitMove({
        ctx,
        taskId: task.id,
        column: KanbanColumn.Removed,
      }),
    ).rejects.toThrow(/reconciler-owned/);
    await expect(
      commitMove({
        ctx,
        taskId: task.id,
        column: KanbanColumn.CleanupBlocked,
      }),
    ).rejects.toThrow(/reconciler-owned/);
  });

  test('allows force move into a reconciler-owned column', async () => {
    const ctx = makeStoreContext('/repo5');
    const task = makeTask('T-eeeeeeeeee');
    await saveTask(ctx, task);
    const next = await commitMove({
      ctx,
      taskId: task.id,
      column: KanbanColumn.Removed,
      force: true,
    });
    expect(next.lifecycleStatus).toBe('removed');
  });
});
