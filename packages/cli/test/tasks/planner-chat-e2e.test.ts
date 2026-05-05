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
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createFileStorage, createLocalFsAdapter } from '@noetic/core';
import { createLocalSubprocessAdapter } from '@noetic/core/adapters/node';

import { createTaskHandler } from '../../src/commands/builtins/tasks/handlers/create.js';
import { ensureChatTarget } from '../../src/commands/builtins/tasks/resolve-chat-target.js';

describe('chat on a task end-to-end', () => {
  let projectRoot: string;

  beforeEach(async () => {
    // Use `/tmp` (not `tmpdir()`) because on macOS `tmpdir()` is
    // `/var/folders/…` and the full socket path
    // `<tasksRoot>/<taskId>/sockets/planner.sock` otherwise blows the
    // 104-byte `sun_path` cap.
    projectRoot = await mkdtemp(join('/tmp', 'noetic-chat-e2e-'));
  });

  afterEach(async () => {
    if (process.env.NOETIC_TEST_KEEP_TMP === '1') {
      console.error(`[keep] ${projectRoot}`);
      return;
    }
    await rm(projectRoot, {
      recursive: true,
      force: true,
    });
  });

  it('planner runner binds its IPC socket so the TUI can open chat', async () => {
    const tasksRoot = join(projectRoot, 'tasks');
    const ctx = {
      fs: createLocalFsAdapter(),
      projectRoot,
      tasksRoot,
    };

    const created = await createTaskHandler(ctx, {
      title: 'test chat hang',
    });

    // The subprocess adapter (with durable storage) is shared across
    // the spawn + resolve calls — the launcher persists the handle
    // manifest into storage, and resolveChatTarget reads back via
    // listLive() through the same adapter.
    const storage = createFileStorage({
      root: join(projectRoot, 'subprocess-storage'),
    });
    const subprocess = createLocalSubprocessAdapter({
      storage,
    });

    // The runner needs *a* key to boot its harness, but the LLM call
    // only happens after the IPC socket is bound — any value works
    // for covering the socket-bind path.
    const apiKey =
      (process.env.OPENROUTER_API_KEY ?? '').length > 0
        ? process.env.OPENROUTER_API_KEY
        : 'test-key-sk-unused';
    const envBefore = process.env.OPENROUTER_API_KEY;
    const noeticHomeBefore = process.env.NOETIC_HOME;
    process.env.OPENROUTER_API_KEY = apiKey;
    process.env.NOETIC_HOME = projectRoot;

    try {
      await ensureChatTarget(ctx, created.task.id, {
        subprocess,
        // Short poll window: we're not trying to chat, only verifying
        // that the launcher succeeded and the runner didn't crash at
        // startup.
        timeoutMs: 3e3,
        pollIntervalMs: 100,
      });
    } finally {
      if (envBefore === undefined) {
        delete process.env.OPENROUTER_API_KEY;
      } else {
        process.env.OPENROUTER_API_KEY = envBefore;
      }
      if (noeticHomeBefore === undefined) {
        delete process.env.NOETIC_HOME;
      } else {
        process.env.NOETIC_HOME = noeticHomeBefore;
      }
    }

    // The runner writes a "planner started" line before touching the
    // LLM — its presence proves the launcher + runner boot chain
    // completed (including `runnerSocketPath()` resolution, which was
    // the site of the original hang).
    const logPath = join(tasksRoot, created.task.id, 'log.jsonl');
    const log = await readFile(logPath, 'utf8').catch(() => '');
    expect(log.includes('planner started')).toBe(true);
  }, 10e3);
});
