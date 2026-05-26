import type { StorageAdapter } from '../../types/memory';
import type { StepSubprocessRequest, SubprocessHandle } from '../../types/subprocess-adapter';
import { isRecord } from './metadata';
import type { InMemoryStepManifest } from './types';

//#region Key layout

const IN_MEMORY_MANIFEST_PREFIX = 'inMemorySubprocess:manifest:';

function manifestKey(handleId: string): string {
  return `${IN_MEMORY_MANIFEST_PREFIX}${handleId}`;
}

//#endregion

//#region Guards

export function isStepManifest(value: unknown): value is InMemoryStepManifest {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.kind === 'step' &&
    typeof value.handleId === 'string' &&
    typeof value.stepId === 'string' &&
    typeof value.executionId === 'string' &&
    typeof value.startedAt === 'string' &&
    isRecord(value.overrides)
  );
}

//#endregion

//#region CRUD

export async function persistStepManifest(
  storage: StorageAdapter,
  request: StepSubprocessRequest,
  handle: SubprocessHandle,
): Promise<void> {
  const manifest: InMemoryStepManifest = {
    kind: 'step',
    handleId: handle.id,
    stepId: request.stepId,
    executionId: request.executionId,
    serializedInput: request.serializedInput,
    overrides: request.overrides,
    startedAt: handle.startedAt,
    reattachMode: 'replay',
  };
  await storage.set(manifestKey(handle.id), manifest);
}

export async function clearManifest(storage: StorageAdapter, handleId: string): Promise<void> {
  await storage.delete(manifestKey(handleId));
}

export async function loadManifest(
  storage: StorageAdapter,
  handleId: string,
): Promise<InMemoryStepManifest | null> {
  const raw = await storage.get<unknown>(manifestKey(handleId));
  if (raw === null) {
    return null;
  }
  return isStepManifest(raw) ? raw : null;
}

export async function listManifests(storage: StorageAdapter): Promise<InMemoryStepManifest[]> {
  const keys = await storage.list(IN_MEMORY_MANIFEST_PREFIX);
  const out: InMemoryStepManifest[] = [];
  for (const key of keys) {
    const raw = await storage.get<unknown>(key);
    if (isStepManifest(raw)) {
      out.push(raw);
    }
  }
  return out;
}

//#endregion
