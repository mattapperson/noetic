import { describe, expect, it } from 'bun:test';
import type { Task } from '@noetic/code-agent/tasks/schema';
import {
  AutopilotState,
  generateTaskId,
  TaskLifecycleStatus,
  TaskReviewStatus,
  TaskSource,
} from '@noetic/code-agent/tasks/schema';
import { saveTask } from '@noetic/code-agent/tasks/store/fs-node';
import { deriveColumn, KanbanColumn, moveTask } from '../../src/commands/builtins/tasks/kanban.js';
import { makeStoreContext } from './_helpers.js';

//#region Fixtures

const NOW = '2026-04-30T00:00:00.000Z';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? generateTaskId(),
    source: TaskSource.Manual,
    title: 't',
    projectRoot: '/repo',
    worktreePath: null,
    branch: null,
    headSha: null,
    reviewStatus: TaskReviewStatus.NotStarted,
    lifecycleStatus: TaskLifecycleStatus.Active,
    paused: false,
    pauseReason: null,
    archivedAt: null,
    hierarchyStatus: null,
    autopilotEnabled: false,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    ...overrides,
  };
}

//#endregion

//#region deriveColumn — review-status × active lifecycle

describe('deriveColumn (active lifecycle)', () => {
  it('maps not_started → triage', () => {
    const t = makeTask({
      reviewStatus: TaskReviewStatus.NotStarted,
    });
    expect(deriveColumn(t)).toBe(KanbanColumn.Triage);
  });

  it('maps reviewing → in_progress', () => {
    const t = makeTask({
      reviewStatus: TaskReviewStatus.Reviewing,
    });
    expect(deriveColumn(t)).toBe(KanbanColumn.InProgress);
  });

  it('maps needs_changes → needs_changes', () => {
    const t = makeTask({
      reviewStatus: TaskReviewStatus.NeedsChanges,
    });
    expect(deriveColumn(t)).toBe(KanbanColumn.NeedsChanges);
  });

  it('maps approved → ready_to_merge', () => {
    const t = makeTask({
      reviewStatus: TaskReviewStatus.Approved,
    });
    expect(deriveColumn(t)).toBe(KanbanColumn.ReadyToMerge);
  });
});

//#endregion

//#region deriveColumn — terminal lifecycle precedence

describe('deriveColumn (terminal lifecycle wins over reviewStatus)', () => {
  it('merged lifecycle collapses into ready_to_merge regardless of reviewStatus', () => {
    for (const reviewStatus of [
      TaskReviewStatus.NotStarted,
      TaskReviewStatus.Reviewing,
      TaskReviewStatus.NeedsChanges,
      TaskReviewStatus.Approved,
    ]) {
      const t = makeTask({
        reviewStatus,
        lifecycleStatus: TaskLifecycleStatus.Merged,
      });
      expect(deriveColumn(t)).toBe(KanbanColumn.ReadyToMerge);
    }
  });

  it('cleanup-blocked lifecycle → cleanup_blocked', () => {
    const t = makeTask({
      lifecycleStatus: TaskLifecycleStatus.CleanupBlocked,
      reviewStatus: TaskReviewStatus.Reviewing,
    });
    expect(deriveColumn(t)).toBe(KanbanColumn.CleanupBlocked);
  });

  it('removed lifecycle → removed', () => {
    const t = makeTask({
      lifecycleStatus: TaskLifecycleStatus.Removed,
      reviewStatus: TaskReviewStatus.Approved,
    });
    expect(deriveColumn(t)).toBe(KanbanColumn.Removed);
  });
});

//#endregion

//#region deriveColumn — archive precedence (boundary at archivedAt presence)

describe('deriveColumn (archivedAt precedence)', () => {
  it('archivedAt=null → not archived (boundary)', () => {
    const t = makeTask({
      archivedAt: null,
    });
    expect(deriveColumn(t)).not.toBe(KanbanColumn.Archived);
  });

  it('archivedAt=string → archived (boundary)', () => {
    const t = makeTask({
      archivedAt: NOW,
    });
    expect(deriveColumn(t)).toBe(KanbanColumn.Archived);
  });

  it('archived takes precedence over merged lifecycle', () => {
    const t = makeTask({
      archivedAt: NOW,
      lifecycleStatus: TaskLifecycleStatus.Merged,
    });
    expect(deriveColumn(t)).toBe(KanbanColumn.Archived);
  });

  it('archived takes precedence over removed lifecycle', () => {
    const t = makeTask({
      archivedAt: NOW,
      lifecycleStatus: TaskLifecycleStatus.Removed,
    });
    expect(deriveColumn(t)).toBe(KanbanColumn.Archived);
  });

  it('archived takes precedence over cleanup-blocked lifecycle', () => {
    const t = makeTask({
      archivedAt: NOW,
      lifecycleStatus: TaskLifecycleStatus.CleanupBlocked,
    });
    expect(deriveColumn(t)).toBe(KanbanColumn.Archived);
  });

  it('archived takes precedence over reviewStatus', () => {
    const t = makeTask({
      archivedAt: NOW,
      reviewStatus: TaskReviewStatus.Approved,
    });
    expect(deriveColumn(t)).toBe(KanbanColumn.Archived);
  });
});

//#endregion

//#region deriveColumn — source independence

describe('deriveColumn (source does not affect column)', () => {
  it('worktree-source still maps via reviewStatus', () => {
    const t = makeTask({
      source: TaskSource.Worktree,
      worktreePath: '/repo/.worktrees/foo',
      reviewStatus: TaskReviewStatus.Reviewing,
    });
    expect(deriveColumn(t)).toBe(KanbanColumn.InProgress);
  });

  it('manual-source archived still goes to archived', () => {
    const t = makeTask({
      source: TaskSource.Manual,
      archivedAt: NOW,
    });
    expect(deriveColumn(t)).toBe(KanbanColumn.Archived);
  });
});

//#endregion

//#region moveTask round-trips

describe('moveTask', () => {
  it('moving to triage clears archivedAt and resets lifecycle to active + reviewStatus=not_started', async () => {
    const ctx = makeStoreContext();
    const t = makeTask({
      archivedAt: NOW,
      lifecycleStatus: TaskLifecycleStatus.Merged,
      reviewStatus: TaskReviewStatus.Approved,
    });
    await saveTask(ctx, t);

    const moved = await moveTask(ctx, {
      taskId: t.id,
      column: KanbanColumn.Triage,
    });

    expect(moved.archivedAt).toBeNull();
    expect(moved.lifecycleStatus).toBe(TaskLifecycleStatus.Active);
    expect(moved.reviewStatus).toBe(TaskReviewStatus.NotStarted);
    expect(deriveColumn(moved)).toBe(KanbanColumn.Triage);
  });

  it('moving to in_progress sets reviewStatus=reviewing', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);

    const moved = await moveTask(ctx, {
      taskId: t.id,
      column: KanbanColumn.InProgress,
    });

    expect(moved.reviewStatus).toBe(TaskReviewStatus.Reviewing);
    expect(moved.lifecycleStatus).toBe(TaskLifecycleStatus.Active);
    expect(deriveColumn(moved)).toBe(KanbanColumn.InProgress);
  });

  it('moving to needs_changes sets reviewStatus=needs_changes', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);

    const moved = await moveTask(ctx, {
      taskId: t.id,
      column: KanbanColumn.NeedsChanges,
    });

    expect(moved.reviewStatus).toBe(TaskReviewStatus.NeedsChanges);
    expect(deriveColumn(moved)).toBe(KanbanColumn.NeedsChanges);
  });

  it('moving to ready_to_merge sets reviewStatus=approved', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);

    const moved = await moveTask(ctx, {
      taskId: t.id,
      column: KanbanColumn.ReadyToMerge,
    });

    expect(moved.reviewStatus).toBe(TaskReviewStatus.Approved);
    expect(deriveColumn(moved)).toBe(KanbanColumn.ReadyToMerge);
  });

  it('moving to cleanup_blocked sets lifecycleStatus=cleanup-blocked', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);

    const moved = await moveTask(ctx, {
      taskId: t.id,
      column: KanbanColumn.CleanupBlocked,
    });

    expect(moved.lifecycleStatus).toBe(TaskLifecycleStatus.CleanupBlocked);
    expect(deriveColumn(moved)).toBe(KanbanColumn.CleanupBlocked);
  });

  it('moving to removed sets lifecycleStatus=removed', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);

    const moved = await moveTask(ctx, {
      taskId: t.id,
      column: KanbanColumn.Removed,
    });

    expect(moved.lifecycleStatus).toBe(TaskLifecycleStatus.Removed);
    expect(deriveColumn(moved)).toBe(KanbanColumn.Removed);
  });

  it('moving to archived sets archivedAt to a non-null timestamp', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);

    const moved = await moveTask(ctx, {
      taskId: t.id,
      column: KanbanColumn.Archived,
    });

    expect(moved.archivedAt).not.toBeNull();
    expect(typeof moved.archivedAt).toBe('string');
    expect(deriveColumn(moved)).toBe(KanbanColumn.Archived);
  });

  it('moving to archived preserves an existing archivedAt timestamp', async () => {
    const ctx = makeStoreContext();
    const ARCHIVED_TS = '2025-01-01T00:00:00.000Z';
    const t = makeTask({
      archivedAt: ARCHIVED_TS,
    });
    await saveTask(ctx, t);

    const moved = await moveTask(ctx, {
      taskId: t.id,
      column: KanbanColumn.Archived,
    });

    expect(moved.archivedAt).toBe(ARCHIVED_TS);
  });

  it('moving from archived to a review-status column clears archivedAt', async () => {
    const ctx = makeStoreContext();
    const t = makeTask({
      archivedAt: NOW,
      reviewStatus: TaskReviewStatus.Reviewing,
    });
    await saveTask(ctx, t);

    const moved = await moveTask(ctx, {
      taskId: t.id,
      column: KanbanColumn.InProgress,
    });

    expect(moved.archivedAt).toBeNull();
    expect(moved.reviewStatus).toBe(TaskReviewStatus.Reviewing);
    expect(moved.lifecycleStatus).toBe(TaskLifecycleStatus.Active);
  });

  it('persists the mutation across reload', async () => {
    const ctx = makeStoreContext();
    const t = makeTask();
    await saveTask(ctx, t);

    await moveTask(ctx, {
      taskId: t.id,
      column: KanbanColumn.ReadyToMerge,
    });

    // Re-read from the store: the canonical record reflects the move.
    const { loadTask } = await import('@noetic/code-agent/tasks/store/fs-node');
    const reloaded = await loadTask(ctx, t.id);
    expect(reloaded.reviewStatus).toBe(TaskReviewStatus.Approved);
    expect(deriveColumn(reloaded)).toBe(KanbanColumn.ReadyToMerge);
  });

  it('bumps updatedAt on every move', async () => {
    const ctx = makeStoreContext();
    const STARTED = '2020-01-01T00:00:00.000Z';
    const t = makeTask({
      updatedAt: STARTED,
    });
    await saveTask(ctx, t);

    const moved = await moveTask(ctx, {
      taskId: t.id,
      column: KanbanColumn.InProgress,
    });

    expect(moved.updatedAt).not.toBe(STARTED);
  });

  it('throws when the task does not exist', async () => {
    const ctx = makeStoreContext();
    await expect(
      moveTask(ctx, {
        taskId: 'T-doesnotex0',
        column: KanbanColumn.InProgress,
      }),
    ).rejects.toThrow(/not found/);
  });
});

//#endregion
