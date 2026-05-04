/**
 * Pilotty-driven e2e test for opening chat on a task.
 *
 * Drives the real `@noetic/cli` TUI via the `pilotty` terminal automation
 * binary. Creates a task in a temp project, launches the TUI, opens the
 * task board (`/tasks`), selects the task, and asserts the chat view
 * transitions from "starting planner agent…" to "chatting with planner"
 * within a reasonable window.
 *
 * This guards against regressions in the planner launcher / runner /
 * IPC-socket binding flow — any break there makes the TUI hang on
 * "starting planner agent…" forever, which is invisible without an
 * end-to-end assertion like this one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/** Poll the session's screen until `needle` appears, or throw on timeout. */
async function waitForScreen(session: string, needle: string, timeoutMs: number): Promise<string> {
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
  throw new Error(`waitForScreen: "${needle}" not found in ${timeoutMs}ms. Last screen:\n${lastScreen}`);
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
const SESSION = `noetic-test-${process.pid}`;

describe.skipIf(!HAS_PILOTTY)('pilotty: open chat on a task', () => {
  let projectRoot: string;
  let taskId: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'noetic-pilotty-'));
    // Create the task via the CLI subcommand so the TUI starts with one
    // row on the board. We could inject state directly, but the real
    // `tasks create` handler is the shortest path that exercises the
    // same code paths the user does.
    const created = spawnSync(
      'bun',
      [
        'run',
        CLI_PATH,
        'tasks',
        'create',
        '--title',
        'pilotty test',
      ],
      {
        cwd: projectRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          NOETIC_DAEMON: '1',
        },
      },
    );
    expect(created.status).toBe(0);
    const match = created.stdout.match(/"id":\s*"(T-[^"]+)"/);
    if (match === null) {
      throw new Error(`could not parse task id from:\n${created.stdout}`);
    }
    taskId = match[1] ?? '';
    expect(taskId.length).toBeGreaterThan(0);
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
    'transitions from "starting planner agent…" to the connected chat view',
    async () => {
      const spawnResult = pilotty([
        'spawn',
        '-n',
        SESSION,
        '--cwd',
        projectRoot,
        'bash',
        '-c',
        `OPENROUTER_API_KEY=test-key-sk-unused bun run ${CLI_PATH} --api-key test-key-sk-unused`,
      ]);
      expect(spawnResult.status).toBe(0);

      // TUI is up when the input prompt is visible.
      await waitForScreen(SESSION, 'Type a message', 10e3);

      // Open the task board via the slash command.
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

      // Board shows the task we created. The narrow 80-column test PTY
      // truncates long task titles to `pilott…`, so match a prefix that
      // survives truncation.
      await waitForScreen(SESSION, 'pilott', 5e3);

      // Enter opens the task detail view; `c` from there opens chat.
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

      // "starting planner agent…" is the spawning placeholder — seeing
      // it proves we got into the chat route. The test then waits for
      // the real chat view to replace it.
      await waitForScreen(SESSION, 'starting planner agent', 5e3);

      // GREEN gate: the runner binds its socket and the view switches
      // from spawning → connected. RED case: hangs forever on the
      // placeholder above. 20s upper bound is generous; the GREEN path
      // typically completes in well under 2s.
      await waitForScreen(SESSION, 'chatting with planner', 20e3);
    },
    45e3,
  );
});
