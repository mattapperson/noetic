/**
 * Pilotty-driven reproduction of the user-reported bug:
 *
 *   "Task T-… · chatting with planner · disconnected: connect ENOENT
 *    /tmp/.noetic/planner-T-….sock"
 *
 * Setup: a task with a pre-existing `_planner.json` sidecar whose
 * `socketPath` points at a socket file that does NOT exist on disk
 * (the exact state a crashed/SIGTERMed/stalled planner leaves behind
 * before this fix). No live runner, no LLM.
 *
 * Open the TUI, navigate to the task board, drill into the task,
 * press `c` to chat. The fix must prevent the TUI from being handed
 * the dead socket path — i.e. the screen must NOT show
 * "disconnected: connect ENOENT <path>". Either a fresh planner
 * spawns (the "starting planner agent…" placeholder appears) or the
 * chat never opens — both are acceptable; a broken connection banner
 * is not.
 *
 * Does NOT require an API key: we only assert the TUI does not
 * surface the ENOENT error. The runner can still fail to come up
 * without the LLM, which is fine for this test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createLocalFsAdapter } from '@noetic/core';

import { createTaskHandler } from '../../src/commands/builtins/tasks/handlers/create.js';
import { savePlanner } from '../../src/commands/builtins/tasks/planner-state.js';

//#region Helpers

interface PilottyResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function pilotty(args: ReadonlyArray<string>, timeoutMs = 10e3): PilottyResult {
  const result = spawnSync('pilotty', args.slice(), {
    encoding: 'utf8',
    timeout: timeoutMs,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function waitForScreen(
  session: string,
  needle: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastScreen = '';
  while (Date.now() < deadline) {
    const { stdout } = pilotty([
      'snapshot',
      '-s',
      session,
      '-f',
      'text',
    ]);
    lastScreen = stdout;
    if (stdout.includes(needle)) {
      return stdout;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `waitForScreen: "${needle}" not found in ${timeoutMs}ms. Last screen:\n${lastScreen}`,
  );
}

async function snapshotText(session: string): Promise<string> {
  return pilotty([
    'snapshot',
    '-s',
    session,
    '-f',
    'text',
  ]).stdout;
}

//#endregion

const HAS_PILOTTY = (() => {
  const { status } = spawnSync('pilotty', [
    '--version',
  ], {
    encoding: 'utf8',
  });
  return status === 0;
})();

const CLI_PATH = join(import.meta.dir, '..', '..', 'src', 'cli', 'cli.ts');
const SESSION = `noetic-stale-${process.pid}`;

describe.skipIf(!HAS_PILOTTY)('pilotty: chat on task with stale planner sidecar', () => {
  let projectRoot: string;
  let taskId: string;

  beforeEach(async () => {
    // `/tmp` keeps the runner socket path under macOS's 104-byte cap.
    projectRoot = await mkdtemp(join('/tmp', 'noetic-stale-pilotty-'));

    const tasksRoot = join(projectRoot, 'tasks');
    const ctx = {
      fs: createLocalFsAdapter(),
      projectRoot,
      tasksRoot,
    };
    const created = await createTaskHandler(ctx, {
      title: 'stale sidecar repro',
    });
    taskId = created.task.id;

    // Drop in the exact stale state the user's task was in: planner
    // sidecar with a socketPath that points at a file that does not
    // exist on disk. `/tmp/.noetic/planner-<taskId>.sock` is the old
    // (pre-home-refactor) socket location; keeping the path short
    // ensures the absence-of-ENOENT assertion is the only signal the
    // test relies on.
    await savePlanner(ctx, {
      taskId,
      sessionId: `${taskId}-dead`,
      pid: 1, // Harmless — no actual process with this pid cares.
      pidStarttime: null,
      startedAt: new Date(Date.now() - 60e3).toISOString(),
      pausedAt: null,
      socketPath: join(tasksRoot, taskId, 'sockets', 'planner.sock'),
    });
  });

  afterEach(async () => {
    pilotty([
      'kill',
      '-s',
      SESSION,
    ]);
    await rm(projectRoot, {
      recursive: true,
      force: true,
    });
  });

  it(
    'never surfaces "disconnected: connect ENOENT" for a stale sidecar',
    async () => {
      const spawnResult = pilotty([
        'spawn',
        '-n',
        SESSION,
        '--cwd',
        projectRoot,
        'bash',
        '-c',
        // NOETIC_HOME redirects the TUI's `/tasks` view and every
        // descendant spawn to the test's temp tasks-root so it sees
        // the pre-seeded stale sidecar instead of the developer's
        // real `~/.noetic/tasks`.
        `NOETIC_HOME=${projectRoot} OPENROUTER_API_KEY=test-key-sk-unused bun run ${CLI_PATH} --api-key test-key-sk-unused`,
      ]);
      expect(spawnResult.status).toBe(0);

      await waitForScreen(SESSION, 'Type a message', 10e3);
      pilotty([
        'type',
        '-s',
        SESSION,
        '/tasks',
      ]);
      pilotty([
        'key',
        '-s',
        SESSION,
        'Enter',
      ]);
      await waitForScreen(SESSION, 'stale', 5e3);

      // Enter the task detail view, then `c` for chat.
      pilotty([
        'key',
        '-s',
        SESSION,
        'Enter',
      ]);
      await waitForScreen(SESSION, 'c to chat with agent', 3e3);
      pilotty([
        'type',
        '-s',
        SESSION,
        'c',
      ]);

      // Wait for whatever view the TUI settles on after pressing `c`.
      // Post-fix, the resolver sees the sidecar's dead socket, rejects
      // it, and either spawns a fresh planner ("starting planner
      // agent…") or returns null and the UI handles it. Either way,
      // the user must not see the ENOENT banner.
      await new Promise((resolve) => setTimeout(resolve, 2e3));
      const screen = await snapshotText(SESSION);

      // The exact banner from the user's report:
      //   "disconnected: connect ENOENT /tmp/.noetic/planner-T-….sock"
      expect(screen.includes('disconnected:')).toBe(false);
      expect(screen.includes('ENOENT')).toBe(false);
    },
    45e3,
  );
});
