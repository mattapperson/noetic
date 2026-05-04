/**
 * End-to-end test for the "open chat on a task" flow.
 *
 * Reproduces the hang where the TUI sits on "starting planner agent…"
 * forever because the spawned planner runner crashes at startup before
 * binding its IPC socket. The TUI polls `resolveChatTarget` for a socket
 * that never arrives.
 *
 * The failure mode is subtle: the launcher's `spawn()` returns a pid,
 * the sidecar is written, and `isAlive(pid)` is true for ~1ms. But the
 * runner throws inside `runnerSocketPath()` (missing required args after
 * the `@noetic/code-agent` extraction) and exits. stdio is `'ignore'`, so
 * nothing surfaces.
 *
 * This test drives the full launcher → runner → `waitForChatTarget` path
 * against a real temp project and fails fast when the runner can't bind.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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

    const target = await ensureChatTarget(ctx, created.task.id, {
      // Generous timeout — the RED case takes the full window, the
      // GREEN case returns in well under a second.
      timeoutMs: 10e3,
      pollIntervalMs: 100,
      startPlannerRunFn: (runArgs) =>
        startPlannerRun({
          ...runArgs,
          spawnFn: visibleSpawn,
        }),
    });

    expect(target).not.toBeNull();
    expect(target?.role).toBe('planner');
    expect(target?.socketPath.length).toBeGreaterThan(0);
    },
    15e3,
  );
});
