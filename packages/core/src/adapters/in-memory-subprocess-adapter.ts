import type {
  SubprocessAdapter,
  SubprocessHandle,
  SubprocessRequest,
} from '../types/subprocess-adapter';

export interface CreateInMemorySubprocessAdapterOptions {
  run?: (request: SubprocessRequest, handle: SubprocessHandle) => Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface CompleteInMemoryRunParams {
  request: SubprocessRequest;
  handle: SubprocessHandle;
  run: CreateInMemorySubprocessAdapterOptions['run'];
  handles: Map<string, SubprocessHandle>;
  active: Set<string>;
  save: (handle: SubprocessHandle) => Promise<SubprocessHandle>;
}

async function completeInMemoryRun({
  request,
  handle,
  run,
  handles,
  active,
  save,
}: CompleteInMemoryRunParams): Promise<void> {
  try {
    await run?.(request, handle);
    const latest = handles.get(handle.id);
    if (!latest || latest.status !== 'running') {
      return;
    }
    active.delete(handle.id);
    await save({
      ...latest,
      status: 'completed',
      updatedAt: nowIso(),
    });
  } catch (err) {
    active.delete(handle.id);
    const latest = handles.get(handle.id) ?? handle;
    await save({
      ...latest,
      status: 'failed',
      updatedAt: nowIso(),
      metadata: {
        ...(latest.metadata ?? {}),
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export function createInMemorySubprocessAdapter(
  options: CreateInMemorySubprocessAdapterOptions = {},
): SubprocessAdapter {
  const handles = new Map<string, SubprocessHandle>();
  const active = new Set<string>();

  async function save(handle: SubprocessHandle): Promise<SubprocessHandle> {
    handles.set(handle.id, handle);
    return handle;
  }

  return {
    async spawn(request) {
      const now = nowIso();
      const handle: SubprocessHandle = {
        id: `subprocess-${crypto.randomUUID()}`,
        status: 'running',
        startedAt: now,
        updatedAt: now,
        metadata: {
          ...(request.metadata ?? {}),
          runtime: 'in-memory',
          command: request.command,
          args: request.args ?? [],
          cwd: request.cwd,
        },
      };
      active.add(handle.id);
      await save(handle);

      void completeInMemoryRun({
        request,
        handle,
        run: options.run,
        handles,
        active,
        save,
      });

      return handle;
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
  };
}
