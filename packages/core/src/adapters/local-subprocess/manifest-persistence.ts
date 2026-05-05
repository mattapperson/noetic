/**
 * Durable-manifest persistence helpers extracted from the local
 * subprocess adapter factory. These functions take an explicit
 * `StorageAdapter` (and for hydration, a `ProcessSignaller`) so the
 * factory itself stays smaller — its cyclomatic complexity was the
 * largest regression in the branch's sentrux gate.
 *
 * Lives here (not inline in `local-subprocess-adapter.ts`) because the
 * entire manifest schema + typeguards + storage interactions form a
 * self-contained unit: they have no dependency on the factory's
 * in-memory `handles` map or on `spawnFn`.
 */

import type { StorageAdapter } from '../../types/memory';
import type {
  ProcessSubprocessRequest,
  StepSubprocessRequest,
  SubprocessHandle,
  SubprocessHandleMetadata,
} from '../../types/subprocess-adapter';
import type { ProcessSignaller } from './types';

//#region Manifest types

/**
 * Persistable manifest for a locally-spawned subprocess. Unlike the
 * in-memory adapter, the local adapter has a real long-lived OS process
 * to rebind to — `pidStarttime` is the drift-detection key that
 * distinguishes the original child from a recycled pid.
 */
export interface LocalStepManifest {
  kind: 'step';
  handleId: string;
  pid: number;
  pidStarttime: string | null;
  stepId: string;
  executionId: string;
  serializedInput: unknown;
  overrides: StepSubprocessRequest['overrides'];
  cwdInit?: string;
  startedAt: string;
  socketPath?: string;
}

export interface LocalProcessManifest {
  kind: 'process';
  handleId: string;
  pid: number;
  pidStarttime: string | null;
  command: string;
  args: ReadonlyArray<string>;
  cwd?: string;
  detached: boolean;
  startedAt: string;
}

export type LocalManifest = LocalStepManifest | LocalProcessManifest;

//#endregion

//#region Keys + typeguards

const LOCAL_MANIFEST_PREFIX = 'localSubprocess:manifest:';

function localManifestKey(handleId: string): string {
  return `${LOCAL_MANIFEST_PREFIX}${handleId}`;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLocalStepManifest(value: unknown): value is LocalStepManifest {
  if (!isRecordValue(value)) {
    return false;
  }
  return (
    value.kind === 'step' &&
    typeof value.handleId === 'string' &&
    typeof value.pid === 'number' &&
    typeof value.stepId === 'string' &&
    typeof value.executionId === 'string' &&
    typeof value.startedAt === 'string' &&
    isRecordValue(value.overrides)
  );
}

function isLocalProcessManifest(value: unknown): value is LocalProcessManifest {
  if (!isRecordValue(value)) {
    return false;
  }
  return (
    value.kind === 'process' &&
    typeof value.handleId === 'string' &&
    typeof value.pid === 'number' &&
    typeof value.command === 'string' &&
    typeof value.startedAt === 'string'
  );
}

function isLocalManifest(value: unknown): value is LocalManifest {
  return isLocalStepManifest(value) || isLocalProcessManifest(value);
}

//#endregion

//#region Low-level storage ops

async function persistLocalManifest(
  storage: StorageAdapter,
  manifest: LocalManifest,
): Promise<void> {
  try {
    await storage.set(localManifestKey(manifest.handleId), manifest);
  } catch (err) {
    console.warn(
      `createLocalSubprocessAdapter: failed to persist manifest for "${manifest.handleId}":`,
      err,
    );
  }
}

async function clearLocalManifest(storage: StorageAdapter, handleId: string): Promise<void> {
  try {
    await storage.delete(localManifestKey(handleId));
  } catch (err) {
    console.warn(`createLocalSubprocessAdapter: failed to clear manifest for "${handleId}":`, err);
  }
}

export async function loadLocalManifest(
  storage: StorageAdapter,
  handleId: string,
): Promise<LocalManifest | null> {
  const raw = await storage.get<unknown>(localManifestKey(handleId));
  if (raw === null) {
    return null;
  }
  return isLocalManifest(raw) ? raw : null;
}

export async function listLocalManifests(storage: StorageAdapter): Promise<LocalManifest[]> {
  const keys = await storage.list(LOCAL_MANIFEST_PREFIX);
  const out: LocalManifest[] = [];
  for (const key of keys) {
    const raw = await storage.get<unknown>(key);
    if (isLocalManifest(raw)) {
      out.push(raw);
    }
  }
  return out;
}

//#endregion

//#region Durable write helpers (called by the adapter factory)

export interface PersistStepArgs {
  storage: StorageAdapter | undefined;
  request: StepSubprocessRequest;
  handle: SubprocessHandle;
  pid: number;
  pidStarttime: string | null;
}

export async function persistStepIfDurable(args: PersistStepArgs): Promise<void> {
  if (!args.storage) {
    return;
  }
  await persistLocalManifest(args.storage, {
    kind: 'step',
    handleId: args.handle.id,
    pid: args.pid,
    pidStarttime: args.pidStarttime,
    stepId: args.request.stepId,
    executionId: args.request.executionId,
    serializedInput: args.request.serializedInput,
    overrides: args.request.overrides,
    cwdInit: args.request.overrides.cwdInit,
    startedAt: args.handle.startedAt,
  });
}

export interface PersistProcessArgs {
  storage: StorageAdapter | undefined;
  request: ProcessSubprocessRequest;
  handle: SubprocessHandle;
  pid: number;
  pidStarttime: string | null;
}

export async function persistProcessIfDurable(args: PersistProcessArgs): Promise<void> {
  if (!args.storage) {
    return;
  }
  await persistLocalManifest(args.storage, {
    kind: 'process',
    handleId: args.handle.id,
    pid: args.pid,
    pidStarttime: args.pidStarttime,
    command: args.request.command,
    args: args.request.args ?? [],
    cwd: args.request.cwd,
    detached: args.request.detached ?? false,
    startedAt: args.handle.startedAt,
  });
}

export async function clearDurableManifest(
  storage: StorageAdapter | undefined,
  handleId: string,
): Promise<void> {
  if (!storage) {
    return;
  }
  await clearLocalManifest(storage, handleId);
}

//#endregion

//#region Hydration

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Build a rehydrated handle from a persisted manifest. Returns `null`
 * when the pid is either gone or the pidStarttime no longer matches —
 * in either case the process we recorded is no longer the one running
 * under that pid, so rebinding would be unsafe.
 */
export function hydrateFromManifest(
  manifest: LocalManifest,
  signaller: ProcessSignaller,
): SubprocessHandle | null {
  if (!signaller.isAlive(manifest.pid)) {
    return null;
  }
  const currentStart = signaller.startTime(manifest.pid);
  if (manifest.pidStarttime !== null && currentStart !== null) {
    if (currentStart !== manifest.pidStarttime) {
      return null;
    }
  }
  const baseMeta: SubprocessHandleMetadata = {
    runtime: 'local',
    pid: manifest.pid,
    pidStarttime: manifest.pidStarttime,
  };
  const metadata: SubprocessHandleMetadata =
    manifest.kind === 'step'
      ? {
          ...baseMeta,
          kind: 'step',
          stepId: manifest.stepId,
          executionId: manifest.executionId,
        }
      : {
          ...baseMeta,
          command: manifest.command,
          args: manifest.args,
          cwd: manifest.cwd,
          detached: manifest.detached,
        };
  return {
    id: manifest.handleId,
    status: 'running',
    startedAt: manifest.startedAt,
    updatedAt: nowIso(),
    metadata,
  };
}

//#endregion
