/**
 * Coverage for the pure helpers exposed by `task-board.tsx`. The Ink
 * rendering itself isn't exercised here — we lean on Bun + biome to
 * catch render-time regressions and instead verify:
 *
 * - `groupTasksByColumn` puts each task into the right bucket and keeps
 *   input order within a bucket.
 * - `selectionAfterKey` clamps within a column, skips empty columns on
 *   horizontal moves, and falls back to the current selection when no
 *   non-empty column lies in the requested direction.
 * - `selectedTask` returns the right card for every coordinate.
 */

import { describe, expect, test } from 'bun:test';
import type { Task } from '@noetic/code-agent/tasks/schema';
import { TaskSource } from '@noetic/code-agent/tasks/schema';
import { KanbanColumn } from '../../../src/commands/builtins/tasks/kanban.js';
import type { DecoratedTask } from '../../../src/commands/builtins/tasks/ui/task-board.js';
import {
  columnLabel,
  groupTasksByColumn,
  selectedTask,
  selectionAfterKey,
  VISIBLE_COLUMNS,
} from '../../../src/commands/builtins/tasks/ui/task-board.js';

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
    pauseReason: null,
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

function decorate(task: Task, column: KanbanColumn, isStructured = false): DecoratedTask {
  return {
    task,
    column,
    isStructured,
  };
}

//#endregion

describe('VISIBLE_COLUMNS', () => {
  test('contains every active column once', () => {
    expect(new Set(VISIBLE_COLUMNS).size).toBe(VISIBLE_COLUMNS.length);
    expect(VISIBLE_COLUMNS.length).toBe(4);
  });

  test('omits terminal-state columns (CleanupBlocked / Removed / Archived)', () => {
    expect(VISIBLE_COLUMNS).not.toContain(KanbanColumn.CleanupBlocked);
    expect(VISIBLE_COLUMNS).not.toContain(KanbanColumn.Removed);
    expect(VISIBLE_COLUMNS).not.toContain(KanbanColumn.Archived);
  });
});

describe('columnLabel', () => {
  test('returns a non-empty label for every column', () => {
    for (const column of VISIBLE_COLUMNS) {
      expect(columnLabel(column).length).toBeGreaterThan(0);
    }
  });

  test('formats well-known columns', () => {
    expect(columnLabel(KanbanColumn.Triage)).toBe('Triage');
    expect(columnLabel(KanbanColumn.InProgress)).toBe('In Progress');
    expect(columnLabel(KanbanColumn.ReadyToMerge)).toBe('Ready to PR');
  });
});

describe('groupTasksByColumn', () => {
  test('produces a bucket for every visible column even when empty', () => {
    const buckets = groupTasksByColumn([]);
    for (const column of VISIBLE_COLUMNS) {
      expect(buckets.has(column)).toBe(true);
      expect(buckets.get(column)).toHaveLength(0);
    }
  });

  test('places each task into its declared column', () => {
    const a = decorate(makeTask('T-aaaaaaaaaa'), KanbanColumn.Triage);
    const b = decorate(makeTask('T-bbbbbbbbbb'), KanbanColumn.InProgress);
    const c = decorate(makeTask('T-cccccccccc'), KanbanColumn.Triage);
    const buckets = groupTasksByColumn([
      a,
      b,
      c,
    ]);
    expect(buckets.get(KanbanColumn.Triage)).toEqual([
      a,
      c,
    ]);
    expect(buckets.get(KanbanColumn.InProgress)).toEqual([
      b,
    ]);
  });
});

describe('selectionAfterKey', () => {
  function makeBuckets(
    layout: ReadonlyArray<{
      column: KanbanColumn;
      n: number;
    }>,
  ): Map<KanbanColumn, DecoratedTask[]> {
    const buckets = new Map<KanbanColumn, DecoratedTask[]>();
    for (const column of VISIBLE_COLUMNS) {
      buckets.set(column, []);
    }
    for (const { column, n } of layout) {
      const slot = buckets.get(column) ?? [];
      for (let i = 0; i < n; i += 1) {
        slot.push(decorate(makeTask(`T-${column}${i}xxxxxx`), column));
      }
      buckets.set(column, slot);
    }
    return buckets;
  }

  test('up clamps at row 0', () => {
    const buckets = makeBuckets([
      {
        column: KanbanColumn.Triage,
        n: 3,
      },
    ]);
    const next = selectionAfterKey({
      columnIndex: 0,
      rowIndex: 0,
      key: 'up',
      buckets,
    });
    expect(next.rowIndex).toBe(0);
  });

  test('down clamps at the last row of the current column', () => {
    const buckets = makeBuckets([
      {
        column: KanbanColumn.Triage,
        n: 2,
      },
    ]);
    const next = selectionAfterKey({
      columnIndex: 0,
      rowIndex: 1,
      key: 'down',
      buckets,
    });
    expect(next.rowIndex).toBe(1);
  });

  test('right skips empty columns and lands on the next non-empty one', () => {
    // VISIBLE_COLUMNS[0]=Triage, [1]=InProgress, [2]=NeedsChanges
    const buckets = makeBuckets([
      {
        column: KanbanColumn.Triage,
        n: 1,
      },
      {
        column: KanbanColumn.NeedsChanges,
        n: 1,
      },
    ]);
    const next = selectionAfterKey({
      columnIndex: 0,
      rowIndex: 0,
      key: 'right',
      buckets,
    });
    expect(next.columnIndex).toBe(VISIBLE_COLUMNS.indexOf(KanbanColumn.NeedsChanges));
  });

  test('right stays put when no non-empty column lies to the right', () => {
    const buckets = makeBuckets([
      {
        column: KanbanColumn.Triage,
        n: 1,
      },
    ]);
    const next = selectionAfterKey({
      columnIndex: 0,
      rowIndex: 0,
      key: 'right',
      buckets,
    });
    expect(next).toEqual({
      columnIndex: 0,
      rowIndex: 0,
    });
  });

  test('left mirrors the right-skip behaviour', () => {
    const buckets = makeBuckets([
      {
        column: KanbanColumn.Triage,
        n: 1,
      },
      {
        column: KanbanColumn.NeedsChanges,
        n: 1,
      },
    ]);
    const startCol = VISIBLE_COLUMNS.indexOf(KanbanColumn.NeedsChanges);
    const next = selectionAfterKey({
      columnIndex: startCol,
      rowIndex: 0,
      key: 'left',
      buckets,
    });
    expect(next.columnIndex).toBe(VISIBLE_COLUMNS.indexOf(KanbanColumn.Triage));
  });

  test('moving into a shorter column clamps the row index', () => {
    const buckets = makeBuckets([
      {
        column: KanbanColumn.Triage,
        n: 4,
      },
      {
        column: KanbanColumn.InProgress,
        n: 2,
      },
    ]);
    const next = selectionAfterKey({
      columnIndex: 0,
      rowIndex: 3,
      key: 'right',
      buckets,
    });
    expect(next.columnIndex).toBe(VISIBLE_COLUMNS.indexOf(KanbanColumn.InProgress));
    expect(next.rowIndex).toBe(1);
  });
});

describe('selectedTask', () => {
  test('returns the task at the selection coordinate', () => {
    const t = decorate(makeTask('T-tttttttttt'), KanbanColumn.Triage);
    const buckets = new Map<KanbanColumn, DecoratedTask[]>([
      [
        KanbanColumn.Triage,
        [
          t,
        ],
      ],
    ]);
    const picked = selectedTask(buckets, {
      columnIndex: 0,
      rowIndex: 0,
    });
    expect(picked).toBe(t);
  });

  test('returns null when the slot is empty', () => {
    const buckets = new Map<KanbanColumn, DecoratedTask[]>([
      [
        KanbanColumn.Triage,
        [],
      ],
    ]);
    const picked = selectedTask(buckets, {
      columnIndex: 0,
      rowIndex: 0,
    });
    expect(picked).toBeNull();
  });

  test('returns null when the column index is out of range', () => {
    const buckets = new Map<KanbanColumn, DecoratedTask[]>();
    const picked = selectedTask(buckets, {
      columnIndex: 99,
      rowIndex: 0,
    });
    expect(picked).toBeNull();
  });
});
