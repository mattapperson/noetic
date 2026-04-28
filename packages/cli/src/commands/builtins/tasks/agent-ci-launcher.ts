import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename, resolve } from 'node:path';

import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import type * as schema from './db/schema.js';
import { taskSessions } from './db/schema.js';

//#region Types

type TasksDb = BunSQLiteDatabase<typeof schema>;

export type AgentCiSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => Pick<ChildProcess, 'pid' | 'unref' | 'on'>;

export interface StartAgentCiRunArgs {
  db: TasksDb;
  taskId: string;
  workflow: string;
  cwd: string;
  spawnFn?: AgentCiSpawn;
  now?: string;
}

export interface StartAgentCiRunResult {
  sessionId: string;
  pid: number;
  workflow: string;
}

export class AgentCiSpawnError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, {
      cause,
    });
    this.name = 'AgentCiSpawnError';
  }
}

//#endregion

//#region Defaults

const defaultSpawn: AgentCiSpawn = (command, args, options) =>
  spawn(
    command,
    [
      ...args,
    ],
    options,
  );

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
  if (child.pid === undefined) {
    throw new AgentCiSpawnError('agent-ci child failed to start: no pid returned by spawn', null);
  }
  const pid = child.pid;
  child.on('error', () => {
    /* swallow; reconciliation marks dead PIDs as failed on next /tasks open */
  });
  child.unref();

  args.db
    .insert(taskSessions)
    .values({
      id: sessionId,
      taskId: args.taskId,
      sessionId,
      kind: 'agent_ci_review',
      status: 'active',
      title: `agent-ci: ${basename(workflow)}`,
      startedAt: now,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
      pid,
      pausedAt: null,
    })
    .run();

  return {
    sessionId,
    pid,
    workflow,
  };
}

//#endregion
