import type {
  ProcessSubprocessRequest,
  StepSubprocessRequest,
  SubprocessAdapter,
  SubprocessHandle,
  SubprocessHandleMetadata,
  SubprocessRequest,
} from '../types/subprocess-adapter';
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
  const handles = new Map<string, SubprocessHandle>();
  const active = new Set<string>();
  const storage = options.storage;

  async function save(handle: SubprocessHandle): Promise<SubprocessHandle> {
    handles.set(handle.id, handle);
    return handle;
  }

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

  async function spawnStepHandle(request: StepSubprocessRequest): Promise<SubprocessHandle> {
    const now = nowIso();
    const handle: SubprocessHandle = {
      id: `subprocess-${crypto.randomUUID()}`,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      metadata: injectMetadata(request, buildStepMetadata(request)),
    };
    active.add(handle.id);
    await save(handle);
    await persistIfDurable(request, handle);
    void completeStepRun({
      request,
      handle,
      stepRunner: options.stepRunner,
      handles,
      active,
      save,
      clearIfDurable,
    });
    return handle;
  }

  async function spawnProcessHandle(request: ProcessSubprocessRequest): Promise<SubprocessHandle> {
    const now = nowIso();
    const handle: SubprocessHandle = {
      id: `subprocess-${crypto.randomUUID()}`,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      metadata: injectMetadata(request, buildProcessMetadata(request)),
    };
    active.add(handle.id);
    await save(handle);
    void completeProcessRun({
      request,
      handle,
      run: options.run,
      handles,
      active,
      save,
      clearIfDurable,
    });
    return handle;
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
        runtime: 'in-memory',
        kind: 'step',
        stepId: manifest.stepId,
        executionId: manifest.executionId,
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
      return handles.get(handleId) ?? null;
    },
    async stop(handleId, reason) {
      const handle = handles.get(handleId);
      if (!handle) {
        return {
          kind: 'not_found',
          handleId,
        };
      }
      active.delete(handleId);
      await clearIfDurable(handleId);
      const next = await save({
        ...handle,
        status: 'stopped',
        updatedAt: nowIso(),
        metadata: {
          ...(handle.metadata ?? {}),
          stopReason: reason,
        },
      });
      return {
        kind: 'stopped',
        handleId,
        handle: next,
      };
    },
    async pause(handleId) {
      const handle = handles.get(handleId);
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
      const handle = handles.get(handleId);
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
      return active.has(handle.id);
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
      const handle = handleFromManifest(manifest);
      active.add(handle.id);
      await save(handle);
      return handle;
    },
    async listLive() {
      const live = new Map<string, SubprocessHandle>();
      for (const id of active) {
        const handle = handles.get(id);
        if (handle) {
          live.set(handle.id, handle);
        }
      }
      if (storage) {
        const manifests = await listManifests(storage);
        for (const manifest of manifests) {
          if (!live.has(manifest.handleId)) {
            live.set(manifest.handleId, handleFromManifest(manifest));
          }
        }
      }
      return [
        ...live.values(),
      ];
    },
  };
}

//#endregion
