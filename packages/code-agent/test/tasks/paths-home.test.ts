/**
 * Tests for the task-state home directory layout.
 *
 * Task state used to live under `<projectRoot>/.noetic/tasks/<taskId>/`,
 * which meant task records, sidecars, and sockets were tied to a
 * specific project checkout. Tasks have since moved to a user-global
 * home so a task is addressable from any project cwd and the same
 * task record survives worktree/project moves.
 *
 * Layout (per user decision):
 *   $HOME/.noetic/tasks/<taskId>/
 *     task.json
 *     _planner.json
 *     _implementer.json
 *     sockets/
 *       planner.sock
 *       implementer-<featureId>.sock
 *     ...
 *
 * `NOETIC_HOME` overrides the base (tests use this to redirect to a
 * temp dir without touching the real user home).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  resolveTasksRoot,
  runnerSocketPath,
  taskDirPaths,
  taskRootPaths,
} from '../../src/tasks/paths.js';

describe('resolveTasksRoot', () => {
  const originalEnv = process.env.NOETIC_HOME;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.NOETIC_HOME;
      return;
    }
    process.env.NOETIC_HOME = originalEnv;
  });

  test('defaults to $HOME/.noetic/tasks when NOETIC_HOME is unset', () => {
    delete process.env.NOETIC_HOME;
    expect(resolveTasksRoot()).toBe(join(homedir(), '.noetic', 'tasks'));
  });

  test('honours NOETIC_HOME override', () => {
    process.env.NOETIC_HOME = '/tmp/noetic-test';
    expect(resolveTasksRoot()).toBe('/tmp/noetic-test/tasks');
  });

  test('treats empty NOETIC_HOME as unset', () => {
    process.env.NOETIC_HOME = '';
    expect(resolveTasksRoot()).toBe(join(homedir(), '.noetic', 'tasks'));
  });

  test('ctx.tasksRoot overrides env and default', () => {
    process.env.NOETIC_HOME = '/tmp/from-env';
    expect(resolveTasksRoot({ tasksRoot: '/tmp/from-ctx/tasks' })).toBe('/tmp/from-ctx/tasks');
  });
});

describe('taskRootPaths', () => {
  const CTX = { tasksRoot: '/tmp/noetic-test/tasks' };

  test('events and state sit at the tasks-root level (cross-task feeds)', () => {
    const paths = taskRootPaths(CTX);
    expect(paths.root).toBe('/tmp/noetic-test/tasks');
    expect(paths.events).toBe('/tmp/noetic-test/tasks/_events.jsonl');
    expect(paths.state).toBe('/tmp/noetic-test/tasks/_state.json');
  });
});

describe('taskDirPaths', () => {
  const CTX = { tasksRoot: '/tmp/noetic-test/tasks' };
  const TASK_ID = 'T-GdGS2Z0WC1';

  test('lays task artifacts out under <tasksRoot>/<taskId>/', () => {
    const paths = taskDirPaths(CTX, TASK_ID);
    expect(paths.dir).toBe('/tmp/noetic-test/tasks/T-GdGS2Z0WC1');
    expect(paths.task).toBe('/tmp/noetic-test/tasks/T-GdGS2Z0WC1/task.json');
    expect(paths.log).toBe('/tmp/noetic-test/tasks/T-GdGS2Z0WC1/log.jsonl');
    expect(paths.chat).toBe('/tmp/noetic-test/tasks/T-GdGS2Z0WC1/chat.jsonl');
    expect(paths.description).toBe('/tmp/noetic-test/tasks/T-GdGS2Z0WC1/description.md');
    expect(paths.hierarchy).toBe('/tmp/noetic-test/tasks/T-GdGS2Z0WC1/hierarchy');
    expect(paths.attachments).toBe('/tmp/noetic-test/tasks/T-GdGS2Z0WC1/attachments');
    expect(paths.steering).toBe('/tmp/noetic-test/tasks/T-GdGS2Z0WC1/steering.md');
  });

  test('sockets live inside the per-task sockets/ subdir', () => {
    const paths = taskDirPaths(CTX, TASK_ID);
    expect(paths.sockets).toBe('/tmp/noetic-test/tasks/T-GdGS2Z0WC1/sockets');
  });
});

describe('runnerSocketPath', () => {
  const CTX = { tasksRoot: '/tmp/noetic-test/tasks' };
  const TASK_ID = 'T-GdGS2Z0WC1';

  test('planner socket sits at <taskDir>/sockets/planner.sock', () => {
    expect(
      runnerSocketPath(CTX, {
        taskId: TASK_ID,
        role: 'planner',
      }),
    ).toBe('/tmp/noetic-test/tasks/T-GdGS2Z0WC1/sockets/planner.sock');
  });

  test('implementer socket includes featureId to distinguish concurrent runners', () => {
    expect(
      runnerSocketPath(CTX, {
        taskId: TASK_ID,
        role: 'implementer',
        runnerId: 'F-abc12345',
      }),
    ).toBe('/tmp/noetic-test/tasks/T-GdGS2Z0WC1/sockets/implementer-F-abc12345.sock');
  });

  test('default path stays under the macOS 104-byte sun_path limit for typical home paths', () => {
    // Simulate a realistic deep-ish user home.
    const ctx = {
      tasksRoot: '/Users/typical-user-name/.noetic/tasks',
    };
    const path = runnerSocketPath(ctx, {
      taskId: 'T-GdGS2Z0WC1',
      role: 'implementer',
      runnerId: 'F-abc12345',
    });
    // `/Users/typical-user-name/.noetic/tasks/T-GdGS2Z0WC1/sockets/implementer-F-abc12345.sock`
    // is 90 bytes.
    expect(Buffer.byteLength(path, 'utf8')).toBeLessThan(104);
  });

  test('falls back to env-resolved root when ctx omits tasksRoot', () => {
    const prev = process.env.NOETIC_HOME;
    process.env.NOETIC_HOME = '/tmp/env-override';
    try {
      expect(
        runnerSocketPath(
          {},
          {
            taskId: TASK_ID,
            role: 'planner',
          },
        ),
      ).toBe('/tmp/env-override/tasks/T-GdGS2Z0WC1/sockets/planner.sock');
    } finally {
      if (prev === undefined) {
        delete process.env.NOETIC_HOME;
      } else {
        process.env.NOETIC_HOME = prev;
      }
    }
  });
});
