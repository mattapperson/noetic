import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import type { Signaller } from '../agent-ci-control.js';
import { defaultSignaller } from '../agent-ci-control.js';
import { recordValidatorRun, updateValidatorRun } from './store.js';

//#region Types

type SpawnedChild = Pick<ChildProcess, 'pid' | 'unref'> & {
  on(event: 'error', listener: (err: Error) => void): unknown;
};

/** @public Pluggable spawn function — primarily a test seam. */
export type ValidatorSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => SpawnedChild;

/** @public Argument bag for {@link startExternalValidatorRun}. */
export interface StartExternalValidatorRunArgs {
  cwd: string;
  featureId: string;
  /** External command to invoke (e.g. project-defined test runner). */
  command: string;
  args: ReadonlyArray<string>;
  spawnFn?: ValidatorSpawn;
  signaller?: Signaller;
  now?: string;
}

/** @public Result returned on a successful spawn. */
export interface StartExternalValidatorRunResult {
  runId: string;
  pid: number;
  command: string;
}

/** @public Thrown when the external validator child process fails to start. */
export class ValidatorSpawnError extends Error {
  constructor(message: string, cause: unknown = null) {
    super(message, {
      cause,
    });
    this.name = 'ValidatorSpawnError';
  }
}

//#endregion

//#region Defaults

const defaultSpawn: ValidatorSpawn = (command, args, options) =>
  spawn(command, args.slice(), options);

//#endregion

//#region Public API

/**
 * @public
 * Fallback path for external (subprocess-based) validation. Most validator
 * runs use the in-process `runValidator()` instead; use this when a project
 * supplies its own test command. Spawns the child detached, verifies the pid
 * is live via the signaller, and persists `pid + pidStarttime` on the
 * mission_validator_runs row.
 */
export function startExternalValidatorRun(
  args: StartExternalValidatorRunArgs,
): StartExternalValidatorRunResult {
  const command = args.command.trim();
  if (command.length === 0) {
    throw new Error('validator command is required');
  }
  const cwd = resolve(args.cwd);
  const spawnFn = args.spawnFn ?? defaultSpawn;
  const signaller = args.signaller ?? defaultSignaller;
  const now = args.now ?? new Date().toISOString();

  // Pre-record the run so we can attach pid metadata atomically once spawn
  // succeeds. If the spawn fails we update status to 'error' so the row never
  // looks "running" with no live pid.
  const run = recordValidatorRun(args.cwd, {
    featureId: args.featureId,
    status: 'running',
    startedAt: now,
  });
  const runId = run.id;

  const child = spawnFn(command, args.args, {
    cwd,
    detached: true,
    stdio: 'ignore',
  });

  // Attach error listener BEFORE any further checks so async ENOENT etc.
  // don't surface as uncaught process errors.
  let asyncSpawnError: unknown = null;
  child.on('error', (err: unknown) => {
    asyncSpawnError = err;
  });
  child.unref();

  if (child.pid === undefined) {
    updateValidatorRun(args.cwd, runId, {
      status: 'error',
      completedAt: new Date().toISOString(),
    });
    throw new ValidatorSpawnError(
      'validator child failed to start: no pid returned by spawn',
      asyncSpawnError,
    );
  }
  const pid = child.pid;

  // Verify the kernel actually has a process for this pid before we record
  // it; catches synchronous-pid-but-immediate-exit races.
  if (!signaller.isAlive(pid)) {
    updateValidatorRun(args.cwd, runId, {
      status: 'error',
      completedAt: new Date().toISOString(),
    });
    throw new ValidatorSpawnError(
      `validator child pid=${pid} did not start (likely ENOENT or invalid command)`,
      asyncSpawnError,
    );
  }
  const pidStarttime = signaller.startTime(pid);

  updateValidatorRun(args.cwd, runId, {
    pid,
    pidStarttime,
  });

  return {
    runId,
    pid,
    command,
  };
}

//#endregion
