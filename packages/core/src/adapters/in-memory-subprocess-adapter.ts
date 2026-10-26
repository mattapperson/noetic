import type {
  ProcessSubprocessRequest,
  SpawnedSubprocess,
  StepSubprocessRequest,
  SubprocessAdapter,
  SubprocessHandle,
  SubprocessHandleMetadata,
  SubprocessRequest,
} from '@noetic-tools/types';
import {
  clearManifest,
  listManifests,
  loadManifest,
  persistStepManifest,
} from './in-memory-subprocess/manifest-persistence';
import {
  buildProcessMetadata,
  buildStepMetadata,
  isProcessRequest,
  isStepRequest,
  nowIso,
} from './in-memory-subprocess/metadata';
import { completeProcessRun, completeStepRun } from './in-memory-subprocess/step-completion';
import type {
  CreateInMemorySubprocessAdapterOptions,
  InMemoryStepManifest,
} from './in-memory-subprocess/types';
import { createLiveHandles } from './live-handles';

export type { CreateInMemorySubprocessAdapterOptions } from './in-memory-subprocess/types';

//#region Factory

/**
 * @public
 * In-memory `SubprocessAdapter` for tests and non-durable in-process
 * step execution. When an optional `StorageAdapter` is supplied the
 * adapter persists per-handle manifests so `reattach()` / `listLive()`
 * work across adapter instances — the reattached handle is an idempotent
 * re-run of the step from the persisted `serializedInput`, not a bind to
 * a live process (there is none to bind to for in-memory).
 */
export function createInMemorySubprocessAdapter(
  options: CreateInMemorySubprocessAdapterOptions = {},
): SubprocessAdapter {
  const live = createLiveHandles();
  const storage = options.storage;

  /**
   * Persist a step manifest after spawn so `reattach` and `listLive` can
   * find this handle again on a subsequent adapter instance. Errors are
   * logged rather than propagated — a failed manifest write must not break
   * otherwise-successful step dispatch.
   */
  async function persistIfDurable(
    request: StepSubprocessRequest,
    handle: SubprocessHandle,
  ): Promise<void> {
    if (!storage) {
      return;
    }
    try {
      await persistStepManifest(storage, request, handle);
    } catch (err) {
      console.warn(
        `createInMemorySubprocessAdapter: failed to persist manifest for "${handle.id}":`,
        err,
      );
    }
  }

  async function clearIfDurable(handleId: string): Promise<void> {
    if (!storage) {
      return;
    }
    try {
      await clearManifest(storage, handleId);
    } catch (err) {
      console.warn(
        `createInMemorySubprocessAdapter: failed to clear manifest for "${handleId}":`,
        err,
      );
    }
  }

  function injectMetadata(
    request: SubprocessRequest,
    intrinsic: SubprocessHandleMetadata,
  ): SubprocessHandleMetadata {
    if (!options.metadataInjector) {
      return intrinsic;
    }
    return {
      ...intrinsic,
      ...options.metadataInjector(request),
    };
  }

  async function spawnStepHandle(request: StepSubprocessRequest): Promise<SpawnedSubprocess> {
    const now = nowIso();
    const spawned = live.add({
      id: `subprocess-${crypto.randomUUID()}`,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      metadata: injectMetadata(request, buildStepMetadata(request)),
    });
    await persistIfDurable(request, spawned.handle);
    void completeStepRun({
      request,
      handle: spawned.handle,
      stepRunner: options.stepRunner,
      live,
      clearIfDurable,
    });
    return spawned;
  }

  function spawnProcessHandle(request: ProcessSubprocessRequest): SpawnedSubprocess {
    const now = nowIso();
    const spawned = live.add({
      id: `subprocess-${crypto.randomUUID()}`,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      metadata: injectMetadata(request, buildProcessMetadata(request)),
    });
    void completeProcessRun({
      request,
      handle: spawned.handle,
      run: options.run,
      live,
      clearIfDurable,
    });
    return spawned;
  }

  /**
   * Build a hydrated handle from a persisted manifest. Status is `running`
   * so consumers see the handle as live; a subsequent `reattach` call
   * re-dispatches the step via the supplied `stepRunner`.
   */
  function handleFromManifest(manifest: InMemoryStepManifest): SubprocessHandle {
    return {
      id: manifest.handleId,
      status: 'running',
      startedAt: manifest.startedAt,
      updatedAt: nowIso(),
      metadata: {
        ...(manifest.metadata ?? {}),
        runtime: 'in-memory',
        kind: 'step',
        stepId: manifest.stepId,
        executionId: manifest.executionId,
        parentExecutionId: manifest.parentExecutionId,
        reattachMode: manifest.reattachMode,
      },
    };
  }

  return {
    async spawn(request) {
      if (isStepRequest(request)) {
        return spawnStepHandle(request);
      }
      if (isProcessRequest(request)) {
        return spawnProcessHandle(request);
      }
      throw new Error('Unsupported subprocess request variant.');
    },
    async get(handleId) {
      return live.get(handleId) ?? null;
    },
    async stop(handleId, reason) {
      const handle = live.get(handleId);
      if (!handle) {
        return {
          kind: 'not_found',
          handleId,
        };
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
    async pause(handleId) {
      const handle = live.get(handleId);
      if (!handle) {
        return {
          kind: 'not_found',
          handleId,
        };
      }
      return {
        kind: 'unsupported',
        handle,
        message: 'In-memory subprocess adapter does not support pause.',
      };
    },
    async resume(handleId) {
      const handle = live.get(handleId);
      if (!handle) {
        return {
          kind: 'not_found',
          handleId,
        };
      }
      return {
        kind: 'unsupported',
        handle,
        message: 'In-memory subprocess adapter does not support resume.',
      };
    },
    async isAlive(handle) {
      return live.get(handle.id) !== undefined;
    },
    /**
     * Idempotent re-run of a persisted step, not a "resume" — for in-memory
     * there is no long-lived process to bind back to. The adapter's
     * `reattachMode` on the manifest reflects this honestly. When no
     * storage was configured we fall back to the ephemeral semantics
     * established in Phase A (returning `null`).
     */
    async reattach(handleId) {
      if (!storage) {
        return null;
      }
      const manifest = await loadManifest(storage, handleId);
      if (!manifest) {
        return null;
      }
      return live.add(handleFromManifest(manifest)).handle;
    },
    async listLive() {
      const found = new Map<string, SubprocessHandle>();
      for (const handle of live.values()) {
        found.set(handle.id, handle);
      }
      if (storage) {
        const manifests = await listManifests(storage);
        for (const manifest of manifests) {
          if (!found.has(manifest.handleId)) {
            found.set(manifest.handleId, handleFromManifest(manifest));
          }
        }
      }
      return [
        ...found.values(),
      ];
    },
  };
}

//#endregion
