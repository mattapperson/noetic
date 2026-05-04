/**
 * End-to-end test for the "open chat on a task" flow.
 *
 * Regression guard for the original bug: the spawned planner runner
 * crashed at startup (undefined projectRoot → `paths[0] must be of
 * type string`) before binding its IPC socket, and the TUI polled
 * `resolveChatTarget` forever for a path that never arrived.
 *
 * Because the stderr of a detached runner goes to `/dev/null` in
 * production, the hang was invisible. This test spawns the real
 * runner with stderr inherited so any startup crash surfaces
 * immediately, and asserts the runner made it far enough to write its
 * "planner started" log entry.
 *
 * Note: we do NOT assert that `ensureChatTarget` returns a non-null
 * target. With the stale-sidecar fix (`planner-runner.ts` now clears
 * the sidecar on exit), a fast LLM completion — or a fast runner
 * crash — leaves the sidecar gone, which is the correct post-state.
 * The "connect to the live runner" path is covered in the pilotty
 * tests when an API key is present; the socket-reachability contract
 * is covered in `resolve-chat-target-staleness.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalFsAdapter } from '@noetic/core';

import { createTaskHandler } from '../../src/commands/builtins/tasks/handlers/create.js';
import type { PlannerSpawn } from '../../src/commands/builtins/tasks/planner-launcher.js';
import { startPlannerRun } from '../../src/commands/builtins/tasks/planner-launcher.js';
import { ensureChatTarget } from '../../src/commands/builtins/tasks/resolve-chat-target.js';

describe('chat on a task end-to-end', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'noetic-chat-e2e-'));
  });

  afterEach(async () => {
    // Keep artifacts on failure for debugging.
    if (process.env.NOETIC_TEST_KEEP_TMP === '1') {
      console.error(`[keep] ${projectRoot}`);
      return;
    }
    await rm(projectRoot, {
      recursive: true,
      force: true,
    });
  });

  it(
    'planner runner binds its IPC socket so the TUI can open chat',
    async () => {
    const ctx = {
      fs: createLocalFsAdapter(),
      projectRoot,
    };

    const created = await createTaskHandler(ctx, {
      title: 'test chat hang',
    });

    // Route the subprocess's stderr to the parent so a runner startup
    // crash (e.g. the hang this test guards against) surfaces in test
    // output instead of silently disappearing into /dev/null.
    const visibleSpawn: PlannerSpawn = (command, args, options) =>
      spawn(command, args.slice(), {
        ...options,
        stdio: [
          'ignore',
          'pipe',
          'inherit',
        ],
        env: {
          ...options.env,
          // The runner needs *a* key to boot its harness, but the LLM
          // call only happens after the IPC socket is bound — any
          // value works for covering the socket-bind path.
          OPENROUTER_API_KEY: (process.env.OPENROUTER_API_KEY ?? '').length > 0
            ? process.env.OPENROUTER_API_KEY
            : 'test-key-sk-unused',
        },
      });

    await ensureChatTarget(ctx, created.task.id, {
      // Short poll window: we're not trying to chat, only verifying
      // that the launcher succeeded and the runner didn't crash at
      // startup. Whether the runner is still alive at assertion time
      // depends on LLM latency — irrelevant here.
      timeoutMs: 3e3,
      pollIntervalMs: 100,
      startPlannerRunFn: (runArgs) =>
        startPlannerRun({
          ...runArgs,
          spawnFn: visibleSpawn,
        }),
    });

    // The runner writes a "planner started" line before touching the
    // LLM — its presence proves the launcher + runner boot chain
    // completed (including `runnerSocketPath()` resolution, which
    // was the site of the original hang). Absence means the runner
    // threw during startup and stderr (inherited above) will show why.
    const logPath = join(projectRoot, '.noetic', 'tasks', created.task.id, 'log.jsonl');
    const log = await readFile(logPath, 'utf8');
    expect(log.includes('planner started')).toBe(true);
    },
    10e3,
  );
});
