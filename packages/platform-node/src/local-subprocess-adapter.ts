import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import type {
  ProcessSubprocessRequest,
  SpawnedSubprocess,
  StepSubprocessRequest,
  StorageAdapter,
  SubprocessAdapter,
  SubprocessControlResult,
  SubprocessHandle,
  SubprocessHandleMetadata,
  SubprocessRequest,
  SubprocessStopResult,
} from '@noetic-tools/core';
import { createLiveHandles, serializeError } from '@noetic-tools/core';
import {
  clearDurableManifest,
  hydrateFromManifest,
  listLocalManifests,
  loadLocalManifest,
  persistProcessIfDurable,
  persistStepIfDurable,
} from './local-subprocess/manifest-persistence';
import type { LocalSpawnFn } from './local-subprocess/step-spawner';
import { spawnStepChild } from './local-subprocess/step-spawner';
import type { ProcessSignaller } from './local-subprocess/types';

export type { ProcessSignaller, SubprocessSignal } from './local-subprocess/types';

export interface CreateLocalSubprocessAdapterOptions {
  spawnFn?: LocalSpawnFn;
  signaller?: ProcessSignaller;
  /**
   * Absolute path to an entry module the step-bootstrap child imports on
   * startup so module-level step registrations populate its registry. Most
   * consumers leave this unset — step-kind requests fall back to a
   * typed error when dispatched without a registry entry, and
   * documentation surfaces the required env var (`NOETIC_REGISTRY_ENTRY`)
   * as the recommended mechanism.
   */
  registryEntry?: string;
  /**
   * Override the path used when the adapter spawns the step bootstrap.
   * Primarily for tests that want to run a fake child. Defaults to the
   * published bootstrap module.
   */
  bootstrapPath?: string;
  /** Override the command used to launch the bootstrap. Defaults to `bun`. */
  bootstrapCommand?: string;
  /**
   * Optional `StorageAdapter` that gives the local adapter a durable handle
   * manifest. When supplied, `spawn()` persists `{handleId, pid,
   * pidStarttime, stepId, serializedInput, executionId, ...}` so that
   * `reattach(handleId)` and `listLive()` survive a parent-process restart.
   *
   * `reattach` uses `ProcessSignaller.startTime(pid)` to detect pid recycle
   * — if the recorded `pidStarttime` does not match the live start time of
   * that pid, the adapter treats the child as gone and returns `null`
   * instead of rebinding to an unrelated process.
   */
  storage?: StorageAdapter;
}

//#endregion

//#region Helpers

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

function readPidStartTime(pid: number): string | null {
  try {
    const out = execFileSync(
      'ps',
      [
        '-p',
        String(pid),
        '-o',
        'lstart=',
      ],
      {
        stdio: [
          'ignore',
          'pipe',
          'ignore',
        ],
        encoding: 'utf8',
      },
    ).trim();
    return out.length === 0 ? null : out;
  } catch {
    return null;
  }
}

export const defaultProcessSignaller: ProcessSignaller = {
  kill(target, signal) {
    process.kill(target, signal);
  },
  isAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return isErrnoException(err) && err.code === 'EPERM';
    }
  },
  startTime(pid) {
    return readPidStartTime(pid);
  },
};

function nowIso(): string {
  return new Date().toISOString();
}

function isStepRequest(request: SubprocessRequest): request is StepSubprocessRequest {
  return request.kind === 'step';
}

/** Resolve the bootstrap module path used for step-kind requests. Phase A
 *  ships a minimal bootstrap that imports the registry entry and invokes the
 *  referenced step — Phase A2 extends it to handle durable IPC. */
function defaultBootstrapPath(): string {
  // The compiled bootstrap lives alongside this file in the node barrel.
  // Keep the resolution lazy so consumers that never invoke step-kind
  // requests don't pay the `fileURLToPath` cost.
  return path.resolve(new URL('../harness/step-bootstrap.ts', import.meta.url).pathname);
}

function buildStepMetadata(
  request: StepSubprocessRequest,
  pid: number,
  startTime: string | null,
): SubprocessHandleMetadata {
  return {
    ...(request.metadata ?? {}),
    runtime: 'local',
    kind: 'step',
    stepId: request.stepId,
    executionId: request.executionId,
    parentExecutionId: request.parentExecutionId,
    pid,
    pidStarttime: startTime,
  };
}

function buildProcessMetadata(
  request: ProcessSubprocessRequest,
  pid: number,
  startTime: string | null,
): SubprocessHandleMetadata {
  return {
    ...(request.metadata ?? {}),
    runtime: 'local',
    pid,
    pidStarttime: startTime,
    command: request.command,
    args: request.args ?? [],
    cwd: request.cwd,
    detached: request.detached ?? false,
  };
}

//#endregion

//#region Factory

export function createLocalSubprocessAdapter(
  options: CreateLocalSubprocessAdapterOptions = {},
): SubprocessAdapter {
  const signaller = options.signaller ?? defaultProcessSignaller;
  const spawnFn: LocalSpawnFn =
    options.spawnFn ?? ((command, args, opts) => spawn(command, args.slice(), opts));
  const live = createLiveHandles();
  const storage = options.storage;

  // Bound durable-manifest helpers — the factory captures `storage` once
  // and exposes thin closures. The heavy lifting (schema, typeguards,
  // pidStarttime drift check) lives in `./local-subprocess/manifest-persistence.ts`.
  const clearIfDurable = (handleId: string): Promise<void> =>
    clearDurableManifest(storage, handleId);

  function patch(handle: SubprocessHandle, status: SubprocessHandle['status']): SubprocessHandle {
    const next = {
      ...handle,
      status,
      updatedAt: nowIso(),
    };
    live.update(next);
    return next;
  }

  function pidFor(handle: SubprocessHandle): number | null {
    return typeof handle.metadata?.pid === 'number' ? handle.metadata.pid : null;
  }

  /**
   * Starts an OS process. A request that carries `stdin` is a run-to-result call (a
   * JSON workflow `runCode` node): its stdio is piped, `stdin` is written and closed,
   * and stdout becomes the handle's `result` when the process exits 0. Without
   * `stdin` the child runs detached from the adapter's I/O, for long-lived processes.
   */
  async function spawnProcessHandle(request: ProcessSubprocessRequest): Promise<SpawnedSubprocess> {
    let asyncSpawnError: unknown = null;
    const captures = request.stdin !== undefined;
    const child = spawnFn(request.command, request.args ?? [], {
      cwd: request.cwd,
      detached: request.detached ?? false,
      stdio: captures ? 'pipe' : 'ignore',
      env: request.env
        ? {
            ...process.env,
            ...request.env,
          }
        : undefined,
    });
    child.on('error', (err) => {
      asyncSpawnError = err;
    });
    const output = captures ? captureOutput(child, request.stdin ?? '') : undefined;
    child.unref();

    if (child.pid === undefined || !signaller.isAlive(child.pid)) {
      throw new Error(
        asyncSpawnError instanceof Error
          ? asyncSpawnError.message
          : `Subprocess failed to start: ${request.command}`,
      );
    }

    const now = nowIso();
    const pid = child.pid;
    const pidStarttime = signaller.startTime(pid);
    const spawned = live.add({
      id: `subprocess-${crypto.randomUUID()}`,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      metadata: buildProcessMetadata(request, pid, pidStarttime),
    });
    const persisted = persistProcessIfDurable({
      storage,
      request,
      handle: spawned.handle,
      pid,
      pidStarttime,
    });
    // Listen before the first await so a child that exits at once still settles. A
    // captured run waits for `close`, which fires only after stdout has drained.
    const settle = (code: number | null): void => {
      void settleProcessExit({
        handleId: spawned.handle.id,
        exitCode: code,
        persisted,
        output,
      });
    };
    if (output) {
      child.on('close', settle);
    } else {
      child.on('exit', settle);
    }
    await persisted;
    return spawned;
  }

  /**
   * Settles a process handle when its OS process exits: exit code 0 completes it,
   * anything else fails it. A captured run's stdout becomes the result; a failed one's
   * error carries the end of its stderr.
   */
  async function settleProcessExit({
    handleId,
    exitCode,
    persisted,
    output,
  }: {
    handleId: string;
    exitCode: number | null;
    persisted: Promise<void>;
    output: CapturedOutput | undefined;
  }): Promise<void> {
    const latest = live.get(handleId);
    if (!latest) {
      return;
    }
    const metadata: SubprocessHandleMetadata = {
      ...(latest.metadata ?? {}),
      exitCode,
    };
    if (exitCode === 0 && output) {
      metadata.result = output.stdout;
    }
    if (exitCode !== 0) {
      metadata.error = {
        message: failureMessage(exitCode, output?.stderr),
      };
    }
    live.settle({
      ...latest,
      status: exitCode === 0 ? 'completed' : 'failed',
      updatedAt: nowIso(),
      metadata,
    });
    await persisted;
    await clearIfDurable(handleId);
  }

  function spawnStepHandleInProcess(
    request: StepSubprocessRequest,
    executor: NonNullable<StepSubprocessRequest['_localExecutor']>,
  ): SpawnedSubprocess {
    const now = nowIso();
    const spawned = live.add({
      id: `subprocess-${crypto.randomUUID()}`,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      metadata: {
        ...(request.metadata ?? {}),
        runtime: 'local',
        kind: 'step',
        stepId: request.stepId,
        executionId: request.executionId,
      },
    });
    void settleStepHandleInProcess(spawned.handle, executor);
    return spawned;
  }

  async function settleStepHandleInProcess(
    handle: SubprocessHandle,
    executor: NonNullable<StepSubprocessRequest['_localExecutor']>,
  ): Promise<void> {
    let metadata: SubprocessHandleMetadata;
    let status: 'completed' | 'failed';
    try {
      const result = await executor();
      status = 'completed';
      metadata = {
        result,
      };
    } catch (err) {
      status = 'failed';
      metadata = {
        error: serializeError(err),
      };
    }
    // A stopped handle has already settled; its late outcome is dropped.
    const latest = live.get(handle.id);
    if (!latest) {
      return;
    }
    live.settle({
      ...latest,
      status,
      updatedAt: nowIso(),
      metadata: {
        ...(latest.metadata ?? {}),
        ...metadata,
      },
    });
  }

  async function spawnStepHandle(request: StepSubprocessRequest): Promise<SpawnedSubprocess> {
    // In-process fast path. When the caller supplies `_localExecutor`
    // (the interpreter always does for same-process dispatches) and no
    // `registryEntry` is configured for out-of-process bootstrapping,
    // run the step here. This mirrors `in-memory-subprocess-adapter` and
    // lets hosts use the local adapter for process-lifecycle handles
    // without forcing every in-process spawn through a child bun runtime.
    const registryEntry = options.registryEntry;
    if (!registryEntry) {
      const executor = request._localExecutor;
      if (executor) {
        return spawnStepHandleInProcess(request, executor);
      }
      throw new Error(
        'Local subprocess adapter cannot dispatch step requests without a registryEntry. ' +
          'Pass `registryEntry` when constructing the adapter so the child can import agent modules.',
      );
    }

    const spawned = spawnStepChild({
      spawnFn,
      signaller,
      request,
      bootstrapCommand: options.bootstrapCommand ?? 'bun',
      bootstrapArgs: [
        'run',
        options.bootstrapPath ?? defaultBootstrapPath(),
      ],
      registryEntry,
    });

    const now = nowIso();
    const started = live.add({
      id: `subprocess-${crypto.randomUUID()}`,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      metadata: buildStepMetadata(request, spawned.pid, spawned.pidStarttime),
    });
    const persisted = persistStepIfDurable({
      storage,
      request,
      handle: started.handle,
      pid: spawned.pid,
      pidStarttime: spawned.pidStarttime,
    });
    // Listen before the first await so a child that exits at once still settles.
    spawned.attachCompletionListener({
      handleId: started.handle.id,
      live,
      persisted,
      clearIfDurable,
    });
    await persisted;
    return started;
  }

  return {
    async spawn(request) {
      if (isStepRequest(request)) {
        return spawnStepHandle(request);
      }
      return spawnProcessHandle(request);
    },
    async get(handleId) {
      return live.get(handleId) ?? null;
    },
    async stop(handleId, reason): Promise<SubprocessStopResult> {
      const handle = live.get(handleId);
      if (!handle) {
        return {
          kind: 'not_found',
          handleId,
        };
      }
      const pid = pidFor(handle);
      if (pid !== null) {
        try {
          signaller.kill(handle.metadata?.detached === true ? -pid : pid, 'SIGTERM');
        } catch {
          /* process may already be gone */
        }
      }
      const next: SubprocessHandle = {
        ...handle,
        status: 'stopped',
        updatedAt: nowIso(),
        metadata: {
          ...(handle.metadata ?? {}),
          stopReason: reason,
        },
      };
      live.settle(next);
      await clearIfDurable(handleId);
      return {
        kind: 'stopped',
        handleId,
        handle: next,
      };
    },
    async pause(handleId): Promise<SubprocessControlResult> {
      const handle = live.get(handleId);
      if (!handle) {
        return {
          kind: 'not_found',
          handleId,
        };
      }
      const pid = pidFor(handle);
      if (pid === null) {
        return {
          kind: 'unsupported',
          handle,
          message: 'Subprocess handle has no pid metadata.',
        };
      }
      signaller.kill(handle.metadata?.detached === true ? -pid : pid, 'SIGSTOP');
      return {
        kind: 'ok',
        handle: patch(handle, 'paused'),
      };
    },
    async resume(handleId): Promise<SubprocessControlResult> {
      const handle = live.get(handleId);
      if (!handle) {
        return {
          kind: 'not_found',
          handleId,
        };
      }
      const pid = pidFor(handle);
      if (pid === null) {
        return {
          kind: 'unsupported',
          handle,
          message: 'Subprocess handle has no pid metadata.',
        };
      }
      signaller.kill(handle.metadata?.detached === true ? -pid : pid, 'SIGCONT');
      return {
        kind: 'ok',
        handle: patch(handle, 'running'),
      };
    },
    async isAlive(handle) {
      const pid = pidFor(handle);
      return pid !== null && signaller.isAlive(pid);
    },
    /**
     * Rebind to a durably-persisted handle across parent-process restarts.
     * Returns `null` when the persisted pid is gone or the `pidStarttime`
     * no longer matches — in either case the recorded process is not the
     * one running under that pid, so we decline to rebind. When storage
     * isn't configured, `reattach` is a no-op and returns `null`.
     */
    async reattach(handleId) {
      if (!storage) {
        return null;
      }
      const manifest = await loadLocalManifest(storage, handleId);
      if (!manifest) {
        return null;
      }
      const handle = hydrateFromManifest(manifest, signaller);
      if (!handle) {
        // Pid drift or process gone — clear the stale manifest so
        // subsequent listLive calls don't re-surface it forever.
        await clearIfDurable(handleId);
        return null;
      }
      return live.add(handle).handle;
    },
    async listLive() {
      // Union the running handles with any persisted manifests that
      // still correspond to a live process by the same pidStarttime.
      const found = new Map<string, SubprocessHandle>();
      for (const handle of live.values()) {
        found.set(handle.id, handle);
      }
      if (storage) {
        const manifests = await listLocalManifests(storage);
        for (const manifest of manifests) {
          if (found.has(manifest.handleId)) {
            continue;
          }
          const hydrated = hydrateFromManifest(manifest, signaller);
          if (!hydrated) {
            await clearIfDurable(manifest.handleId);
            continue;
          }
          found.set(hydrated.id, hydrated);
        }
      }
      return [
        ...found.values(),
      ];
    },
  };
}

//#endregion

//#region Captured Output

/** What a run-to-result child wrote, collected as it streams. */
interface CapturedOutput {
  stdout: string;
  stderr: string;
}

/** The most stderr a failure message quotes, from its end, where the error usually is. */
const STDERR_TAIL_CHARS = 2e3;

/** Writes `stdin` to a piped child and collects its stdout and stderr. */
function captureOutput(child: ReturnType<LocalSpawnFn>, stdin: string): CapturedOutput {
  const output: CapturedOutput = {
    stdout: '',
    stderr: '',
  };
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output.stdout += chunk;
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    output.stderr += chunk;
  });
  // A child that exits without reading its input closes the pipe; that is its business.
  child.stdin?.on('error', () => {});
  child.stdin?.end(stdin);
  return output;
}

function failureMessage(exitCode: number | null, stderr: string | undefined): string {
  const base = `Subprocess exited with code ${exitCode ?? 'null'}`;
  const tail = stderr?.trim().slice(-STDERR_TAIL_CHARS);
  return tail ? `${base}: ${tail}` : base;
}

//#endregion
