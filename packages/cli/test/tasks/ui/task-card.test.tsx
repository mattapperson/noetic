/**
 * Coverage for the pure helpers exposed by the kanban card module. Ink
 * rendering itself is exercised indirectly through `task-board.test.tsx`'s
 * grouping helpers; here we focus on the source-badge / hierarchy-icon /
 * status-icon mapping that drives card visuals.
 */

import { describe, expect, test } from 'bun:test';
import type { Task } from '../../../src/commands/builtins/tasks/schemas.js';
import { TaskSource } from '../../../src/commands/builtins/tasks/schemas.js';
import {
  hierarchyIcon,
  sourceBadge,
  statusIcon,
} from '../../../src/commands/builtins/tasks/ui/task-card.js';

//#region Fixtures

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: 'T-aB3xy_91Qa',
    source: TaskSource.Manual,
    title: 'Sample',
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

//#endregion

describe('sourceBadge', () => {
  test('manual source renders [m]', () => {
    expect(sourceBadge(TaskSource.Manual)).toBe('[m]');
  });

  test('worktree source renders [w]', () => {
    expect(sourceBadge(TaskSource.Worktree)).toBe('[w]');
  });
});

describe('hierarchyIcon', () => {
  test('structured task gets the dropdown glyph', () => {
    expect(hierarchyIcon(true)).toBe(' ▾');
  });

  test('leaf task gets an empty string (no glyph)', () => {
    expect(hierarchyIcon(false)).toBe('');
  });
});

describe('statusIcon', () => {
  test('paused tasks render the pause glyph', () => {
    expect(
      statusIcon(
        makeTask({
          paused: true,
          pauseReason: null,
        }),
      ),
    ).toBe('‖');
  });

  test('archived tasks render the cross glyph', () => {
    expect(
      statusIcon(
        makeTask({
          archivedAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    ).toBe('✕');
  });

  test('active, unpaused tasks render the bullet glyph', () => {
    expect(statusIcon(makeTask())).toBe('●');
  });

  test('paused takes precedence over archived', () => {
    expect(
      statusIcon(
        makeTask({
          paused: true,
          pauseReason: null,
          archivedAt: '2026-01-01T00:00:00.000Z',
        }),
      ),
    ).toBe('‖');
  });
});
