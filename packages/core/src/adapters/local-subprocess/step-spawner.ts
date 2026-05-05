/**
 * Child-process spawn plumbing for step-kind requests. Extracted from
 * `createLocalSubprocessAdapter` so the factory stays below the cc
 * threshold. Handles: launching the bootstrap child via the configured
 * `spawnFn`, verifying pid + startTime, writing the stdin envelope,
 * wiring stdout/stderr buffers, and attaching the close listener.
 *
 * Returns the spawned handle metadata and a function the factory can
 * call once it has registered the handle in its in-memory map and
 * persisted the durable manifest — this keeps the "ready" moment
 * (on('close') listener attached) inside the factory so the
 * handles/save/clearIfDurable closures can still be captured.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { StepSubprocessRequest, SubprocessHandle } from '../../types/subprocess-adapter';
import { handleStepCompletion } from './step-completion';
import type { ProcessSignaller } from './types';

//#region Types

/** Spawn function compatible with `child_process.spawn` — exported so
 *  the factory and this module share a single source of truth. */
export type LocalSpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions,
) => Pick<ChildProcess, 'pid' | 'unref' | 'stdin' | 'stdout' | 'stderr'> & {
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
};

export interface SpawnStepChildArgs {
  spawnFn: LocalSpawnFn;
  signaller: ProcessSignaller;
  request: StepSubprocessRequest;
  bootstrapCommand: string;
  bootstrapArgs: ReadonlyArray<string>;
  registryEntry: string;
}

export interface SpawnStepChildResult {
  pid: number;
  pidStarttime: string | null;
  /** Called by the factory once it has the registered handle and a
   *  capture of the handles map + save/clearIfDurable closures. */
  attachCompletionListener(args: AttachCompletionArgs): void;
}

export interface AttachCompletionArgs {
  handleId: string;
  handles: Map<string, SubprocessHandle>;
  save: (handle: SubprocessHandle) => Promise<SubprocessHandle>;
  clearIfDurable: (handleId: string) => Promise<void>;
}

//#endregion

//#region Public API

/**
 * Spawn the step-bootstrap child, verify liveness, write the stdin
 * envelope, and set up the stdout/stderr capture. Returns the pid +
 * start time plus an `attachCompletionListener` the caller invokes
 * once the handle is registered (so the `on('close')` callback can
 * close over the factory's handle map + save/clearIfDurable closures).
 */
export function spawnStepChild(args: SpawnStepChildArgs): SpawnStepChildResult {
  let asyncSpawnError: unknown = null;
  const child = args.spawnFn(args.bootstrapCommand, args.bootstrapArgs, {
    cwd: args.request.overrides.cwdInit,
    detached: false,
    stdio: [
      'pipe',
      'pipe',
      'pipe',
    ],
    env: {
      ...process.env,
      NOETIC_REGISTRY_ENTRY: args.registryEntry,
    },
  });
  child.on('error', (err) => {
    asyncSpawnError = err;
  });

  if (child.pid === undefined || !args.signaller.isAlive(child.pid)) {
    throw new Error(
      asyncSpawnError instanceof Error
        ? asyncSpawnError.message
        : `Local step subprocess failed to start for step "${args.request.stepId}"`,
    );
  }

  const pid = child.pid;
  const pidStarttime = args.signaller.startTime(pid);

  // Write the request envelope to stdin as a single newline-terminated JSON
  // frame. The child parses one frame on boot.
  const envelope = {
    stepId: args.request.stepId,
    serializedInput: args.request.serializedInput,
    executionId: args.request.executionId,
    overrides: args.request.overrides,
    registryEntry: args.registryEntry,
  };
  if (child.stdin) {
    child.stdin.write(`${JSON.stringify(envelope)}\n`);
    child.stdin.end();
  }

  let stdoutBuf = '';
  let stderrBuf = '';
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
    });
  }

  return {
    pid,
    pidStarttime,
    attachCompletionListener(attach) {
      child.on('close', (code) => {
        void handleStepCompletion({
          handleId: attach.handleId,
          exitCode: code,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          handles: attach.handles,
          save: attach.save,
          clearIfDurable: attach.clearIfDurable,
        });
      });
    },
  };
}

//#endregion
