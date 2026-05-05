/**
 * Integration test for planner-runner sidecar cleanup on exit.
 *
 * Invariant: when the planner runner exits (any path — submit,
 * abandon, stall, signal, crash), the `_planner.json` sidecar for the
 * task is gone. A lingering sidecar points the TUI at a socket that
 * was already unlinked by `ipcServer.close()`, surfacing as
 * "disconnected: connect ENOENT /tmp/.noetic/planner-*.sock".
 *
 * Spawns the real `planner-runner.ts` with no OPENROUTER key so the
 * first LLM call fails fast and the runner unwinds through its
 * finally block. Asserts the sidecar is absent after the process
 * exits.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createLocalFsAdapter } from '@noetic/core';

import { createTaskHandler } from '../../src/commands/builtins/tasks/handlers/create.js';
import { savePlanner } from '../../src/commands/builtins/tasks/planner-state.js';

//#region Helpers

const PLANNER_RUNNER_PATH = join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'commands',
  'builtins',
  'tasks',
  'planner-runner.ts',
);

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return Date.now() - deadline + timeoutMs;
    }
  }
  return -1;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

//#endregion

describe('planner-runner sidecar cleanup', () => {
  let projectRoot: string;

  beforeEach(async () => {
    // `/tmp` (not `tmpdir()`) keeps socket paths under the macOS
    // 104-byte `sun_path` cap.
    projectRoot = await mkdtemp(join('/tmp', 'noetic-runner-cleanup-'));
  });

  afterEach(async () => {
    await rm(projectRoot, {
      recursive: true,
      force: true,
    });
  });

  it(
    'clears _planner.json and unlinks the socket after the runner exits',
    async () => {
      const tasksRoot = join(projectRoot, 'tasks');
      const ctx = {
        fs: createLocalFsAdapter(),
        projectRoot,
        tasksRoot,
      };
      const created = await createTaskHandler(ctx, {
        title: 'cleanup test',
      });
      const taskId = created.task.id;
      const taskDir = join(tasksRoot, taskId);
      const sidecarPath = join(taskDir, '_planner.json');

      // Pre-write the sidecar so the runner's `loadPlanner()` sees it.
      // The real launcher does this; we short-circuit by writing it
      // directly so the test doesn't depend on the launcher.
      await savePlanner(ctx, {
        taskId,
        sessionId: `${taskId}-sess`,
        pid: process.pid,
        pidStarttime: null,
        startedAt: new Date().toISOString(),
        pausedAt: null,
      });

      // Spawn the runner with stderr inherited so any crash surfaces.
      // No OPENROUTER_API_KEY → the first LLM call fails, the runner
      // nudge triggers, and the runner exits through its finally
      // block (the exact path that leaves a stale sidecar today).
      const child = spawn(
        'bun',
        [
          'run',
          PLANNER_RUNNER_PATH,
        ],
        {
          cwd: projectRoot,
          stdio: [
            'ignore',
            'pipe',
            'inherit',
          ],
          env: {
            ...process.env,
            NOETIC_TASK_DIR: taskDir,
            NOETIC_TASK_CWD: projectRoot,
            // Redirect the runner's tasks-root so its `taskDirPaths()`
            // resolves under the test's temp dir rather than the
            // developer's real `~/.noetic/tasks`.
            NOETIC_HOME: projectRoot,
            OPENROUTER_API_KEY: 'test-key-sk-unused',
          },
        },
      );

      await new Promise<void>((resolve, reject) => {
        child.once('exit', () => resolve());
        child.once('error', reject);
      });

      // Post-exit invariants:
      // 1. The sidecar file must be gone. A leftover sidecar is what
      //    causes the TUI to connect to a dead socket.
      expect(await fileExists(sidecarPath)).toBe(false);

      // 2. The socket file must be unlinked (ipcServer.close handles
      //    this already — asserted here so regressions show up
      //    immediately if the close path changes).
      const socketPath = join(taskDir, 'sockets', 'planner.sock');
      expect(await fileExists(socketPath)).toBe(false);

      // 3. The runner process is actually gone — guards against a
      //    hang that would leave tests to time out silently.
      const childPid = child.pid ?? 0;
      if (childPid > 0) {
        expect(await waitForProcessExit(childPid, 500)).not.toBe(-1);
      }
    },
    20e3,
  );
});
