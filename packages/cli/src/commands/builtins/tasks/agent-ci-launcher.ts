import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename, resolve } from 'node:path';

import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import type { Signaller } from './agent-ci-control.js';
import { defaultSignaller } from './agent-ci-control.js';
import type * as schema from './db/schema.js';
import { AGENT_CI_REVIEW_KIND, taskSessions } from './db/schema.js';

//#region Types

type TasksDb = BunSQLiteDatabase<typeof schema>;

type SpawnedChild = Pick<ChildProcess, 'pid' | 'unref'> & {
  on(event: 'error', listener: (err: Error) => void): unknown;
};

export type AgentCiSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => SpawnedChild;

export interface StartAgentCiRunArgs {
  db: TasksDb;
  taskId: string;
  workflow: string;
  cwd: string;
  spawnFn?: AgentCiSpawn;
  signaller?: Signaller;
  now?: string;
}

export interface StartAgentCiRunResult {
  sessionId: string;
  pid: number;
  workflow: string;
}

export class AgentCiSpawnError extends Error {
  constructor(message: string, cause: unknown = null) {
    super(message, {
      cause,
    });
    this.name = 'AgentCiSpawnError';
  }
}

//#endregion

//#region Defaults

const defaultSpawn: AgentCiSpawn = (command, args, options) =>
  spawn(command, args.slice(), options);

function makeSessionId(taskId: string): string {
  return `${taskId}-${randomBytes(4).toString('hex')}`;
}

//#endregion

//#region Public API

export function startAgentCiRun(args: StartAgentCiRunArgs): StartAgentCiRunResult {
  const workflow = args.workflow.trim();
  if (workflow.length === 0) {
    throw new Error('workflow path is required');
  }
  const cwd = resolve(args.cwd);
  const spawnFn = args.spawnFn ?? defaultSpawn;
  const signaller = args.signaller ?? defaultSignaller;
  const now = args.now ?? new Date().toISOString();
  const sessionId = makeSessionId(args.taskId);

  const child = spawnFn(
    'npx',
    [
      '@redwoodjs/agent-ci',
      'run',
      '--workflow',
      workflow,
    ],
    {
      cwd,
      detached: true,
      stdio: 'ignore',
    },
  );
  // Attach error listener BEFORE any further checks so async ENOENT etc.
  // don't surface as uncaught process errors. DO NOT add DB writes between
  // spawn and INSERT — we'd risk a detached child with no tracking row.
  let asyncSpawnError: unknown = null;
  child.on('error', (err: unknown) => {
    asyncSpawnError = err;
  });
  child.unref();

  if (child.pid === undefined) {
    throw new AgentCiSpawnError(
      'agent-ci child failed to start: no pid returned by spawn',
      asyncSpawnError,
    );
  }
  const pid = child.pid;

  // Verify the kernel actually has a process for this pid before we record
  // it; catches synchronous-pid-but-immediate-exit races (e.g. ENOENT on npx).
  if (!signaller.isAlive(pid)) {
    throw new AgentCiSpawnError(
      `agent-ci child pid=${pid} did not start (likely ENOENT or invalid workflow)`,
      asyncSpawnError,
    );
  }
  const pidStarttime = signaller.startTime(pid);

  args.db
    .insert(taskSessions)
    .values({
      id: sessionId,
      taskId: args.taskId,
      sessionId,
      kind: AGENT_CI_REVIEW_KIND,
      status: 'active',
      title: `agent-ci: ${basename(workflow)}`,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      pid,
      pausedAt: null,
      pidStarttime,
    })
    .run();

  return {
    sessionId,
    pid,
    workflow,
  };
}

//#endregion
