import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import type { StorageAdapter } from '../types/memory';
import type {
  ProcessSubprocessRequest,
  StepSubprocessRequest,
  SubprocessAdapter,
  SubprocessControlResult,
  SubprocessHandle,
  SubprocessHandleMetadata,
  SubprocessRequest,
  SubprocessStopResult,
} from '../types/subprocess-adapter';
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
  const handles = new Map<string, SubprocessHandle>();
  const active = new Set<string>();
  const storage = options.storage;

  async function save(handle: SubprocessHandle): Promise<SubprocessHandle> {
    handles.set(handle.id, handle);
    if (handle.status === 'running' || handle.status === 'starting' || handle.status === 'paused') {
      active.add(handle.id);
    } else {
      active.delete(handle.id);
    }
    return handle;
  }

  // Bound durable-manifest helpers — the factory captures `storage` once
  // and exposes thin closures. The heavy lifting (schema, typeguards,
  // pidStarttime drift check) lives in `./local-subprocess/manifest-persistence.ts`.
  const clearIfDurable = (handleId: string): Promise<void> =>
    clearDurableManifest(storage, handleId);

  async function patch(
    handle: SubprocessHandle,
    status: SubprocessHandle['status'],
  ): Promise<SubprocessHandle> {
    return save({
      ...handle,
      status,
      updatedAt: nowIso(),
    });
  }

  function pidFor(handle: SubprocessHandle): number | null {
    return typeof handle.metadata?.pid === 'number' ? handle.metadata.pid : null;
  }

  async function spawnProcessHandle(request: ProcessSubprocessRequest): Promise<SubprocessHandle> {
    let asyncSpawnError: unknown = null;
    const child = spawnFn(request.command, request.args ?? [], {
      cwd: request.cwd,
      detached: request.detached ?? false,
      stdio: 'ignore',
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
    const handle = await save({
      id: `subprocess-${crypto.randomUUID()}`,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      metadata: buildProcessMetadata(request, pid, pidStarttime),
    });
    await persistProcessIfDurable({
      storage,
      request,
      handle,
      pid,
      pidStarttime,
    });
    return handle;
  }

  async function spawnStepHandle(request: StepSubprocessRequest): Promise<SubprocessHandle> {
    const registryEntry = options.registryEntry;
    if (!registryEntry) {
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
    const handle = await save({
      id: `subprocess-${crypto.randomUUID()}`,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      metadata: buildStepMetadata(request, spawned.pid, spawned.pidStarttime),
    });
    await persistStepIfDurable({
      storage,
      request,
      handle,
      pid: spawned.pid,
      pidStarttime: spawned.pidStarttime,
    });
    spawned.attachCompletionListener({
      handleId: handle.id,
      handles,
      save,
      clearIfDurable,
    });
    return handle;
  }

  return {
    async spawn(request) {
      if (isStepRequest(request)) {
        return spawnStepHandle(request);
      }
      return spawnProcessHandle(request);
    },
    async get(handleId) {
      return handles.get(handleId) ?? null;
    },
    async stop(handleId, reason): Promise<SubprocessStopResult> {
      const handle = handles.get(handleId);
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
      await clearIfDurable(handleId);
      const next = await patch(
        {
          ...handle,
          metadata: {
            ...(handle.metadata ?? {}),
            stopReason: reason,
          },
        },
        'stopped',
      );
      return {
        kind: 'stopped',
        handleId,
        handle: next,
      };
    },
    async pause(handleId): Promise<SubprocessControlResult> {
      const handle = handles.get(handleId);
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
        handle: await patch(handle, 'paused'),
      };
    },
    async resume(handleId): Promise<SubprocessControlResult> {
      const handle = handles.get(handleId);
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
        handle: await patch(handle, 'running'),
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
      await save(handle);
      return handle;
    },
    async listLive() {
      // Union the in-memory active set with any persisted manifests that
      // still correspond to a live process by the same pidStarttime.
      const live = new Map<string, SubprocessHandle>();
      for (const id of active) {
        const handle = handles.get(id);
        if (handle) {
          live.set(handle.id, handle);
        }
      }
      if (storage) {
        const manifests = await listLocalManifests(storage);
        for (const manifest of manifests) {
          if (live.has(manifest.handleId)) {
            continue;
          }
          const hydrated = hydrateFromManifest(manifest, signaller);
          if (!hydrated) {
            await clearIfDurable(manifest.handleId);
            continue;
          }
          live.set(hydrated.id, hydrated);
        }
      }
      return [
        ...live.values(),
      ];
    },
  };
}

//#endregion
