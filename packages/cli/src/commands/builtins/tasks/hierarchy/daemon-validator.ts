/**
 * Production `runValidator` for the daemon-mode validator flow. Replaces
 * the `noRunnerConfigured` stub that previously short-circuited every
 * validator request with an `error` outcome.
 *
 * The default validator strategy is "run `bun test` in the leaf task's
 * worktree": exit 0 → `pass`, non-zero → `fail`, spawn-or-IO error →
 * `error`. Projects that need different validation should construct a
 * harness with a custom `runValidator` and bypass this default.
 *
 * Why a thin wrapper rather than calling {@link validatorLauncherTool}
 * directly: that tool spawns the child detached and returns a pid, so it
 * doesn't satisfy the {@link RunValidatorFn} contract (which must resolve
 * with a structured outcome). This module owns the spawn-and-await
 * lifecycle and translates exit code → outcome.
 */

import type { SpawnOptions } from 'node:child_process';
import { spawn } from 'node:child_process';

import { tryLoadTask } from '../fs-store.js';
import type { RunValidatorArgs, ValidatorRunOutcome } from './validator-job.js';

//#region Types

interface SpawnedChild {
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** Pluggable spawn — primarily a test seam. */
export type ValidatorShellSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => SpawnedChild;

export interface CreateShellValidatorOpts {
  /** Test seam: replace the default `node:child_process#spawn`. */
  readonly spawnFn?: ValidatorShellSpawn;
  /**
   * Validator command to invoke. Defaults to `bun`.
   */
  readonly command?: string;
  /**
   * Validator command arguments. Defaults to `['test']`. The runner
   * inserts the leaf task's worktree as the cwd; arguments don't need
   * to specify a path.
   */
  readonly args?: ReadonlyArray<string>;
  /**
   * Maximum stdout/stderr bytes to retain in the outcome `summary`.
   * Bounds the validator outcome row size for very chatty test runners.
   */
  readonly maxOutputBytes?: number;
}

interface SpawnResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

//#endregion

//#region Helpers

const DEFAULT_COMMAND = 'bun';
const DEFAULT_ARGS: ReadonlyArray<string> = [
  'test',
];
const DEFAULT_MAX_OUTPUT_BYTES = 4096;

const defaultSpawn: ValidatorShellSpawn = (command, args, options) =>
  spawn(command, args.slice(), options);

function clampOutput(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.byteLength <= maxBytes) {
    return text;
  }
  // Byte-bounded slice — `String.prototype.slice` counts UTF-16 code
  // units, which over-counts characters in multi-byte payloads (a
  // 4-byte emoji is 2 UTF-16 units), so the invariant has to live on
  // the Buffer side. `toString('utf-8')` gracefully replaces a
  // half-character at the boundary with U+FFFD.
  return `${buf.subarray(0, maxBytes).toString('utf-8')}\n…[truncated]`;
}

interface SpawnAndWaitArgs {
  readonly spawnFn: ValidatorShellSpawn;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  /**
   * Hard cap on stdout/stderr accumulation per stream. A wedged
   * validator that never exits but spits out megabytes would otherwise
   * grow memory unbounded inside this closure. Once the cap is hit,
   * subsequent chunks are dropped — only the first {@link captureCap}
   * bytes are retained per stream.
   */
  readonly captureCap: number;
}

async function spawnAndWait(input: SpawnAndWaitArgs): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve, reject) => {
    let child: SpawnedChild;
    try {
      child = input.spawnFn(input.command, input.args, {
        cwd: input.cwd,
        stdio: [
          'ignore',
          'pipe',
          'pipe',
        ],
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stdout, 'utf-8') >= input.captureCap) {
        return;
      }
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderr, 'utf-8') >= input.captureCap) {
        return;
      }
      stderr += chunk.toString('utf-8');
    });
    child.on('error', (err: unknown) => {
      reject(err);
    });
    child.on('exit', (code: number | null) => {
      resolve({
        exitCode: code,
        stdout,
        stderr,
      });
    });
  });
}

function outcomeFromExit(args: {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  command: string;
  maxOutputBytes: number;
}): ValidatorRunOutcome {
  const summary = clampOutput(
    args.stdout.length > 0 ? args.stdout : args.stderr,
    args.maxOutputBytes,
  );
  if (args.exitCode === 0) {
    return {
      status: 'pass',
      summary: summary.length > 0 ? summary : `${args.command} exited 0`,
    };
  }
  if (args.exitCode === null) {
    return {
      status: 'error',
      summary: `${args.command} was killed by a signal`,
    };
  }
  return {
    status: 'fail',
    summary: summary.length > 0 ? summary : `${args.command} exited ${args.exitCode}`,
  };
}

//#endregion

//#region Public API

/**
 * Build a {@link RunValidatorFn} that shells out to `bun test` (by
 * default) inside the leaf task's worktree. Returns `error` when the
 * leaf task has no worktree provisioned yet, so the upstream validator
 * flow can record the run as terminal without an indefinite hang.
 */
export function createShellValidator(opts: CreateShellValidatorOpts = {}) {
  const spawnFn = opts.spawnFn ?? defaultSpawn;
  const command = opts.command ?? DEFAULT_COMMAND;
  const args = opts.args ?? DEFAULT_ARGS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return async function runValidator(input: RunValidatorArgs): Promise<ValidatorRunOutcome> {
    const leafTaskId = input.feature.taskId;
    if (leafTaskId === null) {
      return {
        status: 'error',
        summary: `feature ${input.feature.id} has no linked leaf task`,
      };
    }
    const leafTask = await tryLoadTask(input.ctx, leafTaskId);
    if (leafTask === null) {
      return {
        status: 'error',
        summary: `leaf task ${leafTaskId} not found`,
      };
    }
    if (leafTask.worktreePath === null || leafTask.worktreePath.length === 0) {
      return {
        status: 'error',
        summary: `leaf task ${leafTaskId} has no worktree provisioned`,
      };
    }
    try {
      // Cap accumulated output at 4× the post-truncation budget so a
      // wedged validator can't OOM the daemon, while still leaving
      // enough headroom for `clampOutput` to truncate cleanly.
      const result = await spawnAndWait({
        spawnFn,
        command,
        args,
        cwd: leafTask.worktreePath,
        captureCap: maxOutputBytes * 4,
      });
      return outcomeFromExit({
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        command,
        maxOutputBytes,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        status: 'error',
        summary: `validator spawn failed: ${message}`,
      };
    }
  };
}

//#endregion
