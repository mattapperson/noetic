/**
 * Forgetting a thread or an execution: deleting every record core keeps for it,
 * after settling the spend it left pending, and listing what is stored so a host
 * never builds a storage key itself (spec 23 § Forgetting).
 */

import type {
  ForgetOptions,
  ForgetReport,
  ListStoredOptions,
  SpendSettlement,
  StorageAdapter,
  StoredExecution,
} from '@noetic-tools/types';
import { ExecutionPart, NoeticErrorImpl } from '@noetic-tools/types';
import type { CheckpointStore } from '../runtime/durable/checkpoint-store';
import type { SessionRecord, SessionStore } from '../runtime/durable/session-store';
import { SESSION_PREFIX, sessionKey } from '../runtime/durable/session-store';
import type { SpendRecord } from '../runtime/durable/spend-log';
import type { TurnLeaseOptions } from '../runtime/durable/turn-lease';
import { LEASE_PREFIX, leaseKey, TurnLease } from '../runtime/durable/turn-lease';
import { OUTPUT_PREFIX, outputKey } from '../runtime/output-store';
import { executionsOf } from './thread-record';

//#region Types

/** @internal What forgetting needs from its harness. */
export interface ForgetHost {
  /** The harness's durable storage. Undefined when it has none. */
  readonly storage?: StorageAdapter;
  /** Where display output is kept: `storage`, or memory without it. */
  readonly outputStorage: StorageAdapter;
  readonly checkpointStore?: CheckpointStore;
  readonly sessionStore?: SessionStore;
  readonly leaseOptions?: TurnLeaseOptions;
  /** True when this harness has a turn of the thread running. */
  threadBusy(threadId: string): boolean;
  /** True when this harness has a run in flight on the execution. */
  executionBusy(executionId: string): boolean;
  /** Settle the pending dispatches `owns` picks; empty without durable storage. */
  closeSpend(
    owns: (record: SpendRecord) => boolean,
    patienceMs?: number,
  ): Promise<SpendSettlement[]>;
  /** `clearCheckpoint`: the snapshot, ledger, held calls and pending entries. */
  clearCheckpoint(executionId: string): Promise<void>;
  /** Wait for the thread's queued display output to land, then drop it from memory. */
  settleOutput(threadId: string): Promise<void>;
  /** Drop what this harness holds in memory for the thread: its session and park watch. */
  dropThread(threadId: string): void;
}

//#endregion

//#region Keys

const EXECUTION_PREFIX = 'execution:';
const LAYERS_PREFIX = 'layers/';

/** The suffixes an execution's keys carry after its id, and the part each is. */
const PART_PATTERN = /^(.+?):(snapshot|ledger|trail|held|intent|pending)(?::|$)/;

/** The execution and part a key under `execution:` belongs to. */
function parseExecutionKey(key: string):
  | {
      executionId: string;
      part: ExecutionPart;
    }
  | undefined {
  if (!key.startsWith(EXECUTION_PREFIX)) {
    return undefined;
  }
  const rest = key.slice(EXECUTION_PREFIX.length);
  const match = PART_PATTERN.exec(rest);
  if (match?.[1] && match[2]) {
    return {
      executionId: match[1],
      part: toPart(match[2]),
    };
  }
  // A key core does not write: its id is up to the last colon.
  const colon = rest.lastIndexOf(':');
  return colon > 0
    ? {
        executionId: rest.slice(0, colon),
        part: ExecutionPart.Other,
      }
    : undefined;
}

const PARTS: Record<string, ExecutionPart> = {
  snapshot: ExecutionPart.Snapshot,
  ledger: ExecutionPart.Ledger,
  trail: ExecutionPart.Trail,
  held: ExecutionPart.Held,
  intent: ExecutionPart.Intent,
  pending: ExecutionPart.Pending,
};

function toPart(name: string): ExecutionPart {
  return PARTS[name] ?? ExecutionPart.Other;
}

/** The scope key of a context layer's state key (`layers/<layerId>/<scopeKey>/...`). */
function layerScopeMatches(key: string, scopeKeys: ReadonlySet<string>): boolean {
  const rest = key.slice(LAYERS_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) {
    return false;
  }
  const scoped = rest.slice(slash + 1);
  for (const scopeKey of scopeKeys) {
    if (scoped.startsWith(`${scopeKey}/`)) {
      return true;
    }
  }
  return false;
}

/** Ids of keys under `prefix` that start with `idPrefix`. */
async function idsUnder(
  storage: StorageAdapter,
  prefix: string,
  idPrefix: string,
): Promise<string[]> {
  const keys = await storage.list(`${prefix}${idPrefix}`);
  return keys.map((key) => key.slice(prefix.length));
}

async function deleteAll(storage: StorageAdapter, keys: ReadonlyArray<string>): Promise<void> {
  for (const key of keys) {
    await storage.delete(key);
  }
}

//#endregion

//#region Refusals

function busy(threadOrExecution: string, reason: string): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'lease_lost',
    executionId: threadOrExecution,
    term: 0,
    reason,
  });
}

//#endregion

//#region Forget

/** Delete everything stored for one execution, and its layer state. */
async function forgetExecutionState(
  host: ForgetHost,
  executionIds: ReadonlyArray<string>,
  keepTrail: boolean,
): Promise<void> {
  for (const executionId of executionIds) {
    await host.clearCheckpoint(executionId);
  }
  const storage = host.storage;
  if (!storage) {
    return;
  }
  const wanted = new Set(executionIds);
  for (const executionId of executionIds) {
    const keys = (await storage.list(`${EXECUTION_PREFIX}${executionId}:`)).filter((key) => {
      const parsed = parseExecutionKey(key);
      return (
        parsed !== undefined &&
        wanted.has(parsed.executionId) &&
        !(keepTrail && parsed.part === ExecutionPart.Trail)
      );
    });
    await deleteAll(storage, keys);
  }
}

/** Delete context-layer state kept at any of `scopeKeys`. */
async function forgetLayerState(
  storage: StorageAdapter | undefined,
  scopeKeys: ReadonlySet<string>,
): Promise<void> {
  if (!storage || scopeKeys.size === 0) {
    return;
  }
  const keys = (await storage.list(LAYERS_PREFIX)).filter((key) =>
    layerScopeMatches(key, scopeKeys),
  );
  await deleteAll(storage, keys);
}

/** The thread's stored record, or undefined when it has none or it does not read. */
async function recordOf(host: ForgetHost, threadId: string): Promise<SessionRecord | undefined> {
  return host.sessionStore?.load(threadId);
}

/** Refuse a thread whose turn runs here, or whose lease another harness holds. */
async function takeThread(
  host: ForgetHost,
  threadId: string,
  under: {
    record: SessionRecord | undefined;
    waitMs: number;
  },
): Promise<TurnLease | undefined> {
  const { record, waitMs } = under;
  const live = executionsOf(record).find((id) => host.executionBusy(id));
  if (host.threadBusy(threadId) || live !== undefined) {
    throw busy(threadId, `thread "${threadId}" has a turn running in this harness`);
  }
  if (!host.leaseOptions) {
    return undefined;
  }
  // Taking the lease raises its term, so a harness that stalled mid-turn loses its next write.
  return TurnLease.take(
    {
      ...host.leaseOptions,
      waitMs,
    },
    threadId,
    {
      above: record?.term,
    },
  );
}

/**
 * @internal
 * Forget a thread: settle its spend, then delete its executions, layer state,
 * display output, record and lease, in that order.
 */
export async function forgetThread(
  host: ForgetHost,
  threadId: string,
  options: ForgetOptions = {},
): Promise<ForgetReport> {
  const before = await recordOf(host, threadId);
  await takeThread(host, threadId, {
    record: before,
    waitMs: options.waitMs ?? 0,
  });
  const executions = new Set(executionsOf(before));
  const spend = await host.closeSpend(
    (record) =>
      record.threadId === threadId ||
      (record.executionId !== undefined && executions.has(record.executionId)),
    options.patienceMs,
  );
  // Settling can outlast the lease: take it again, and read the record again under it,
  // in case a turn began meanwhile.
  const after = await recordOf(host, threadId);
  await takeThread(host, threadId, {
    record: after,
    waitMs: 0,
  });
  for (const executionId of executionsOf(after)) {
    executions.add(executionId);
  }
  const executionIds = [
    ...executions,
  ];
  host.dropThread(threadId);
  await forgetExecutionState(host, executionIds, options.keepTrail === true);
  await forgetLayerState(
    host.storage,
    new Set([
      threadId,
      ...executionIds,
    ]),
  );
  await host.settleOutput(threadId);
  await host.outputStorage.delete(outputKey(threadId));
  if (host.storage) {
    await host.storage.delete(sessionKey(threadId));
    await host.storage.delete(leaseKey(threadId));
  }
  return {
    threadId,
    executionIds,
    spend,
  };
}

/**
 * @internal
 * Forget one execution: settle its spend, then delete everything under
 * `execution:<id>:` and its layer state. A thread's record is left alone.
 */
export async function forgetExecution(
  host: ForgetHost,
  executionId: string,
  options: ForgetOptions = {},
): Promise<ForgetReport> {
  if (host.executionBusy(executionId)) {
    throw busy(executionId, `execution "${executionId}" has a run in flight in this harness`);
  }
  const spend = await host.closeSpend(
    (record) => record.executionId === executionId,
    options.patienceMs,
  );
  await forgetExecutionState(
    host,
    [
      executionId,
    ],
    options.keepTrail === true,
  );
  await forgetLayerState(
    host.storage,
    new Set([
      executionId,
    ]),
  );
  return {
    executionIds: [
      executionId,
    ],
    spend,
  };
}

//#endregion

//#region Listing

/** @internal Every thread with a record, a lease, or display output stored. */
export async function listStoredThreads(
  host: ForgetHost,
  options: ListStoredOptions = {},
): Promise<string[]> {
  const prefix = options.prefix ?? '';
  const found = new Set(await idsUnder(host.outputStorage, OUTPUT_PREFIX, prefix));
  const storage = host.storage;
  if (storage) {
    for (const keyPrefix of [
      SESSION_PREFIX,
      LEASE_PREFIX,
    ]) {
      for (const id of await idsUnder(storage, keyPrefix, prefix)) {
        found.add(id);
      }
    }
  }
  return [
    ...found,
  ].sort();
}

/** @internal Every execution with anything stored, and what is stored for it. */
export async function listStoredExecutions(
  host: ForgetHost,
  options: ListStoredOptions = {},
): Promise<StoredExecution[]> {
  const prefix = options.prefix ?? '';
  const parts = new Map<string, Set<ExecutionPart>>();
  const add = (executionId: string, part: ExecutionPart): void => {
    if (!executionId.startsWith(prefix)) {
      return;
    }
    const known = parts.get(executionId) ?? new Set<ExecutionPart>();
    known.add(part);
    parts.set(executionId, known);
  };
  for (const key of (await host.storage?.list(`${EXECUTION_PREFIX}${prefix}`)) ?? []) {
    const parsed = parseExecutionKey(key);
    if (parsed) {
      add(parsed.executionId, parsed.part);
    }
  }
  // A checkpoint store of the host's own may keep snapshots outside `storage`.
  for (const { executionId } of (await host.checkpointStore?.list()) ?? []) {
    add(executionId, ExecutionPart.Snapshot);
  }
  return [
    ...parts,
  ]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([executionId, stored]) => ({
      executionId,
      parts: [
        ...stored,
      ],
      resumable: stored.has(ExecutionPart.Snapshot) || stored.has(ExecutionPart.Ledger),
    }));
}

//#endregion
