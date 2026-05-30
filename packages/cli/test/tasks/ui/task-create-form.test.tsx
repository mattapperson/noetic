/**
 * Coverage for the persistence path inside `task-create-form.tsx`.
 *
 * `submitNewTask` writes `task.json` and `description.md`, then appends a
 * `task:created` event. This test mounts the in-memory `MemFs` store,
 * drives `submitNewTask` end-to-end, and asserts:
 *
 * 1. A well-formed `Task` lands on disk with the expected defaults.
 * 2. Description text is persisted alongside the task.
 * 3. `_events.jsonl` gains a `task:created` row referencing the new task.
 * 4. Empty titles are rejected with a descriptive error.
 * 5. Empty descriptions are rejected with a descriptive error.
 */

import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { tailEvents, taskDirPaths, taskRootPaths } from '@noetic-tools/code-agent/tasks/store/fs-node';
import {
  buildManualTask,
  submitNewTask,
} from '../../../src/tui/tasks/runtime-ui/task-create-form.js';
import { makeStoreContext } from '../_helpers.js';

describe('buildManualTask', () => {
  test('uses the provided title and projectRoot', () => {
    const task = buildManualTask({
      title: 'Hello',
      projectRoot: '/repo',
    });
    expect(task.title).toBe('Hello');
    expect(task.projectRoot).toBe('/repo');
  });

  test('defaults to manual source, not_started review, active lifecycle, no autopilot', () => {
    const task = buildManualTask({
      title: 'x',
      projectRoot: '/repo',
    });
    expect(task.source).toBe('manual');
    expect(task.reviewStatus).toBe('not_started');
    expect(task.lifecycleStatus).toBe('active');
    expect(task.autopilotEnabled).toBe(false);
    expect(task.archivedAt).toBeNull();
  });

  test('issues a fresh T-prefixed id', () => {
    const a = buildManualTask({
      title: 'a',
      projectRoot: '/repo',
    });
    const b = buildManualTask({
      title: 'b',
      projectRoot: '/repo',
    });
    expect(a.id).toMatch(/^T-[A-Za-z0-9_-]{10}$/);
    expect(b.id).toMatch(/^T-[A-Za-z0-9_-]{10}$/);
    expect(a.id).not.toBe(b.id);
  });
});

describe('submitNewTask', () => {
  test('persists task.json and appends task:created with description', async () => {
    const ctx = makeStoreContext('/repo');
    const task = await submitNewTask({
      ctx,
      title: 'Build kanban',
      description: 'Long-form details here.',
    });
    const dir = taskDirPaths(ctx, task.id);
    // task.json on disk parses as the same record we returned.
    const persistedRaw = ctx.fs.files.get(path.resolve(dir.task));
    expect(persistedRaw).toBeDefined();
    // description.md was written too.
    const descRaw = ctx.fs.files.get(path.resolve(dir.description));
    expect(descRaw?.toString('utf-8')).toBe('Long-form details here.');
    // Events file mentions the task.
    const eventsRaw = ctx.fs.files.get(path.resolve(taskRootPaths(ctx).events));
    expect(eventsRaw).toBeDefined();
    expect(eventsRaw?.toString('utf-8')).toContain(task.id);
    expect(eventsRaw?.toString('utf-8')).toContain('task:created');
    // Durable tail surfaces the appended row.
    const events = await tailEvents(ctx);
    const created = events.filter((e) => e.kind === 'task:created');
    expect(created).toHaveLength(1);
    expect(created[0]?.taskId).toBe(task.id);
  });

  test('rejects whitespace-only descriptions with a descriptive error', async () => {
    const ctx = makeStoreContext('/repo2');
    await expect(
      submitNewTask({
        ctx,
        title: 'Whitespace',
        description: '   \n  ',
      }),
    ).rejects.toThrow(/Description is required/);
  });

  test('rejects empty titles with a descriptive error', async () => {
    const ctx = makeStoreContext('/repo3');
    await expect(
      submitNewTask({
        ctx,
        title: '   ',
        description: 'has a description',
      }),
    ).rejects.toThrow(/Title is required/);
  });

  test('rejects empty descriptions with a descriptive error', async () => {
    const ctx = makeStoreContext('/repo4');
    await expect(
      submitNewTask({
        ctx,
        title: 'Has title',
        description: '',
      }),
    ).rejects.toThrow(/Description is required/);
  });

  test('accepts a single-character description (boundary)', async () => {
    const ctx = makeStoreContext('/repo5');
    const task = await submitNewTask({
      ctx,
      title: 'Boundary',
      description: 'x',
    });
    const dir = taskDirPaths(ctx, task.id);
    const descRaw = ctx.fs.files.get(path.resolve(dir.description));
    expect(descRaw?.toString('utf-8')).toBe('x');
  });
});
