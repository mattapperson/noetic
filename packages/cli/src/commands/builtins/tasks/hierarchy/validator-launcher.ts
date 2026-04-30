import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import type { Signaller } from '../agent-ci-control.js';
import { defaultSignaller } from '../agent-ci-control.js';
import type { ValidatorRun } from './schemas.js';
import { ValidatorRunStatus } from './schemas.js';
import type { ValidatorContext } from './validator.js';
import { loadValidatorRun, recordValidatorRun, updateValidatorRun } from './validator.js';

//#region Types

type SpawnedChild = Pick<ChildProcess, 'pid' | 'unref'> & {
  on(event: 'error', listener: (err: Error) => void): unknown;
};

/** Pluggable spawn function — primarily a test seam. */
export type ValidatorSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => SpawnedChild;

/** Argument bag for {@link startExternalValidatorRun}. */
export interface StartExternalValidatorRunArgs {
  /** Validator context (carries fs, projectRoot, taskId). */
  readonly ctx: ValidatorContext;
  readonly featureId: string;
  /** External command to invoke (e.g. project-defined test runner). */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Working directory for the spawned child (defaults to ctx.projectRoot). */
  readonly cwd?: string;
  readonly spawnFn?: ValidatorSpawn;
  readonly signaller?: Signaller;
  readonly now?: string;
}

/** Argument bag for {@link spawnValidatorChild}. */
export interface SpawnValidatorChildArgs {
  /** Validator context (carries fs, projectRoot, taskId). */
  readonly ctx: ValidatorContext;
  readonly featureId: string;
  /** Pre-existing validator run id whose pid metadata we will populate. */
  readonly runId: string;
  /** External command to invoke (e.g. project-defined test runner). */
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Working directory for the spawned child (defaults to ctx.projectRoot). */
  readonly cwd?: string;
  readonly spawnFn?: ValidatorSpawn;
  readonly signaller?: Signaller;
}

/** Result returned on a successful spawn. */
export interface StartExternalValidatorRunResult {
  readonly run: ValidatorRun;
  readonly runId: string;
  readonly pid: number;
  readonly command: string;
}

/** Result returned on a successful {@link spawnValidatorChild}. */
export interface SpawnValidatorChildResult {
  readonly run: ValidatorRun;
  readonly pid: number;
  readonly pidStarttime: string | null;
}

/** Thrown when the external validator child process fails to start. */
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

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

//#endregion

//#region Public API

/**
 * Spawn the external validator child for an already-recorded validator run.
 * Verifies the run row exists, performs the detached spawn, and patches
 * `pid + pidStarttime` onto the row. On failure the row's status is patched
 * to `error` so the daemon never observes a "running" row with no live pid.
 *
 * This is the spawn-only kernel of {@link startExternalValidatorRun}; the
 * {@link validatorLauncherTool} wrapper calls this directly so the tool
 * input contract (taskId/featureId/runId) matches a flow where the run row
 * was created upstream.
 */
export async function spawnValidatorChild(
  args: SpawnValidatorChildArgs,
): Promise<SpawnValidatorChildResult> {
  const command = args.command.trim();
  if (command.length === 0) {
    throw new Error('validator command is required');
  }
  const cwd = resolve(args.cwd ?? args.ctx.projectRoot);
  const spawnFn = args.spawnFn ?? defaultSpawn;
  const signaller = args.signaller ?? defaultSignaller;

  const existing = await loadValidatorRun(args.ctx, args.featureId, args.runId);
  if (existing === null) {
    throw new Error(`Validator run ${args.runId} not found for feature ${args.featureId}.`);
  }

  const child = spawnFn(command, args.args, {
    cwd,
    detached: true,
    stdio: 'ignore',
  });

  // Attach error listener BEFORE any further checks so async ENOENT etc. don't
  // surface as uncaught process errors.
  let asyncSpawnError: unknown = null;
  child.on('error', (err: unknown) => {
    asyncSpawnError = err;
  });
  child.unref();

  if (child.pid === undefined) {
    await updateValidatorRun(args.ctx, {
      featureId: args.featureId,
      runId: args.runId,
      patch: {
        status: ValidatorRunStatus.Error,
        completedAt: nowIso(),
      },
    });
    throw new ValidatorSpawnError(
      'validator child failed to start: no pid returned by spawn',
      asyncSpawnError,
    );
  }
  const pid = child.pid;

  // Verify the kernel actually has a process for this pid before we record it;
  // catches synchronous-pid-but-immediate-exit races.
  if (!signaller.isAlive(pid)) {
    await updateValidatorRun(args.ctx, {
      featureId: args.featureId,
      runId: args.runId,
      patch: {
        status: ValidatorRunStatus.Error,
        completedAt: nowIso(),
      },
    });
    throw new ValidatorSpawnError(
      `validator child pid=${pid} did not start (likely ENOENT or invalid command)`,
      asyncSpawnError,
    );
  }
  const pidStarttime = signaller.startTime(pid);

  const updated = await updateValidatorRun(args.ctx, {
    featureId: args.featureId,
    runId: args.runId,
    patch: {
      pid,
      pidStarttime,
    },
  });

  return {
    run: updated,
    pid,
    pidStarttime,
  };
}

/**
 * Fallback path for external (subprocess-based) validation. Most validator
 * runs use the in-process validator harness; use this when a project supplies
 * its own test command. Records the validator run row, then delegates to
 * {@link spawnValidatorChild} for the spawn-and-attach-pid logic.
 *
 * Order of writes: row created (status=running) → spawn → pid attached on
 * row. If spawn fails the row's status is patched to `error` so the daemon
 * never observes a "running" row with no live pid.
 */
export async function startExternalValidatorRun(
  args: StartExternalValidatorRunArgs,
): Promise<StartExternalValidatorRunResult> {
  const command = args.command.trim();
  if (command.length === 0) {
    throw new Error('validator command is required');
  }
  const startedAt = args.now ?? nowIso();

  // Pre-record the run so we can attach pid metadata atomically once spawn
  // succeeds.
  const run = await recordValidatorRun(args.ctx, {
    featureId: args.featureId,
    status: ValidatorRunStatus.Running,
    startedAt,
  });

  const result = await spawnValidatorChild({
    ctx: args.ctx,
    featureId: args.featureId,
    runId: run.id,
    command,
    args: args.args,
    cwd: args.cwd,
    spawnFn: args.spawnFn,
    signaller: args.signaller,
  });

  return {
    run: result.run,
    runId: run.id,
    pid: result.pid,
    command,
  };
}

//#endregion
