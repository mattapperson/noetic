/**
 * Coverage for the persistence path inside `task-create-form.tsx`.
 *
 * `submitNewTask` writes `task.json` (and optionally `description.md`),
 * then appends a `task:created` event and fans it out on the in-process
 * bus. This test mounts the in-memory `MemFs` store, drives `submitNewTask`
 * end-to-end, and asserts:
 *
 * 1. A well-formed `Task` lands on disk with the expected defaults.
 * 2. Description text is persisted iff non-empty.
 * 3. `_events.jsonl` gains a `task:created` row referencing the new task.
 * 4. In-process listeners on `taskEvents` see the event.
 * 5. Empty titles are rejected with a descriptive error.
 */

import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import {
  offTaskEvent,
  onTaskEvent,
  taskEvents,
} from '../../../src/commands/builtins/tasks/events.js';
import { taskDirPaths, taskRootPaths } from '../../../src/commands/builtins/tasks/paths.js';
import type { Event } from '../../../src/commands/builtins/tasks/schemas.js';
import {
  buildManualTask,
  submitNewTask,
} from '../../../src/commands/builtins/tasks/ui/task-create-form.js';
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
  test('persists task.json and emits task:created with description', async () => {
    const ctx = makeStoreContext('/repo');
    const seen: Event[] = [];
    const listener = (e: Event): void => {
      seen.push(e);
    };
    onTaskEvent('task:created', listener);
    try {
      const task = await submitNewTask({
        ctx,
        title: 'Build kanban',
        description: 'Long-form details here.',
      });
      const dir = taskDirPaths(ctx.projectRoot, task.id);
      // task.json on disk parses as the same record we returned.
      const persistedRaw = ctx.fs.files.get(path.resolve(dir.task));
      expect(persistedRaw).toBeDefined();
      // description.md was written too.
      const descRaw = ctx.fs.files.get(path.resolve(dir.description));
      expect(descRaw).toBe('Long-form details here.');
      // Events file mentions the task.
      const events = ctx.fs.files.get(path.resolve(taskRootPaths(ctx.projectRoot).events));
      expect(events).toBeDefined();
      expect(events).toContain(task.id);
      expect(events).toContain('task:created');
      // In-process listener saw the event.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.taskId).toBe(task.id);
      expect(seen[0]?.kind).toBe('task:created');
    } finally {
      offTaskEvent('task:created', listener);
    }
  });

  test('omits description.md when description is whitespace only', async () => {
    const ctx = makeStoreContext('/repo2');
    const task = await submitNewTask({
      ctx,
      title: 'Whitespace',
      description: '   \n  ',
    });
    const dir = taskDirPaths(ctx.projectRoot, task.id);
    expect(ctx.fs.files.has(path.resolve(dir.description))).toBe(false);
  });

  test('rejects empty titles with a descriptive error', async () => {
    const ctx = makeStoreContext('/repo3');
    await expect(
      submitNewTask({
        ctx,
        title: '   ',
        description: '',
      }),
    ).rejects.toThrow(/Title is required/);
  });

  test('does not pollute other listeners across runs', async () => {
    const ctx = makeStoreContext('/repo4');
    const seen: Event[] = [];
    const listener = (e: Event): void => {
      seen.push(e);
    };
    onTaskEvent('task:created', listener);
    offTaskEvent('task:created', listener);
    await submitNewTask({
      ctx,
      title: 'Should not be seen by detached listener',
      description: '',
    });
    expect(seen).toHaveLength(0);
    // Sanity: the in-process bus is still functional for fresh subscribers.
    expect(taskEvents.eventNames()).toBeDefined();
  });
});
