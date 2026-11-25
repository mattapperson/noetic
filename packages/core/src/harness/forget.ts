/**
 * Forgetting a thread or an execution: deleting every record core keeps for it,
 * after settling the spend it left pending, and listing what is stored so a host
 * never builds a storage key itself (spec 23 § Forgetting).
 */

import { storageGetMany } from '@noetic-tools/context';
import type {
  ForgetOptions,
  ForgetReport,
  ListStoredOptions,
  SpendSettlement,
  StorageAdapter,
  StoredExecution,
  SubprocessAdapter,
} from '@noetic-tools/types';
import { ExecutionPart, NoeticConfigError, NoeticErrorImpl } from '@noetic-tools/types';
import { poolLeasesOf } from '../connections/pool';
import type { CheckpointStore } from '../runtime/durable/checkpoint-store';
import type { ChildLink } from '../runtime/durable/child-links';
import {
  adapterOfChild,
  adaptersUsedBy,
  ChildAdapterSource,
  ChildLinkSchema,
  runsInProcess,
} from '../runtime/durable/child-links';
import type { SessionRecord, SessionStore } from '../runtime/durable/session-store';
import { SESSION_PREFIX, sessionKey } from '../runtime/durable/session-store';
import type { SpendRecord } from '../runtime/durable/spend-log';
import type { TurnLeaseOptions } from '../runtime/durable/turn-lease';
import { LEASE_PREFIX, leaseKey, TurnLease } from '../runtime/durable/turn-lease';
import { OUTPUT_PREFIX, outputKey } from '../runtime/output-store';
import { lookupStep } from '../runtime/step-registry';
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
  /** Ids of the context layers this harness keeps durable state for. */
  layerIds(): ReadonlyArray<string>;
  /** Release the pool leases this harness still holds for the run, freeing their connections. */
  releaseConnections(executionId: string): Promise<void>;
  /** The harness's `environment.subprocess`. */
  readonly subprocess: SubprocessAdapter;
  /** The harness itself: what it dispatched out of process is kept against it. */
  readonly harness: object;
}

//#endregion

//#region Keys

const EXECUTION_PREFIX = 'execution:';
const LAYERS_PREFIX = 'layers/';

/** Each part core writes under an execution, and what may follow its name. */
const PART_TAILS: Record<string, RegExp> = {
  snapshot: /^$/,
  ledger: /^:\d+$/,
  trail: /^:\d+$/,
  held: /^:.+$/,
  intent: /^:.+$/,
  pending: /^:.+$/,
  child: /^:[^:]+$/,
};

/** Every place a part's name may start in what follows `execution:`. */
const PART_NAME = /:(snapshot|ledger|trail|held|intent|pending|child)(?=:|$)/g;

/**
 * The execution id and part of a key core writes, read as the longest id whose
 * part is well formed: `a:child:trail:1` is execution `a:child`'s trail, and
 * `a:child:<id>` is execution `a`'s link to child `<id>`.
 */
function parseCoreKey(rest: string):
  | {
      executionId: string;
      part: string;
      tail: string;
    }
  | undefined {
  const starts = [
    ...rest.matchAll(PART_NAME),
  ].reverse();
  for (const match of starts) {
    const part = match[1] ?? '';
    const at = match.index ?? 0;
    const tail = rest.slice(at + 1 + part.length);
    if (at > 0 && PART_TAILS[part]?.test(tail)) {
      return {
        executionId: rest.slice(0, at),
        part,
        tail: tail.slice(1),
      };
    }
  }
  return undefined;
}

/** An execution's key, with the execution and the part it belongs to. */
interface ExecutionKey {
  key: string;
  executionId: string;
  part: ExecutionPart;
  /** What follows the part's name: a child's id for a `child` link. */
  tail?: string;
}

/**
 * The execution and part of each key under `execution:`. A key core writes is read by
 * its part's suffix. Any other key belongs to the longest execution id, among those
 * core's keys name, that it starts with — else to the id up to its first colon — so
 * `execution:a:b:custom` is execution `a:b`'s when `a:b` has records of its own.
 */
function parseExecutionKeys(keys: ReadonlyArray<string>): ExecutionKey[] {
  const known = new Set<string>();
  const parsed: ExecutionKey[] = [];
  const unknown: string[] = [];
  for (const key of keys) {
    const match = key.startsWith(EXECUTION_PREFIX)
      ? parseCoreKey(key.slice(EXECUTION_PREFIX.length))
      : undefined;
    if (match) {
      known.add(match.executionId);
      parsed.push({
        key,
        executionId: match.executionId,
        part: toPart(match.part),
        tail: match.tail,
      });
      continue;
    }
    unknown.push(key);
  }
  for (const key of unknown) {
    const owner = ownerOf(key, known);
    if (owner !== undefined) {
      parsed.push({
        key,
        executionId: owner,
        part: ExecutionPart.Other,
      });
    }
  }
  return parsed;
}

/** The execution a key core does not write belongs to. */
function ownerOf(key: string, known: ReadonlySet<string>): string | undefined {
  if (!key.startsWith(EXECUTION_PREFIX)) {
    return undefined;
  }
  const rest = key.slice(EXECUTION_PREFIX.length);
  let owner: string | undefined;
  for (const id of known) {
    if (rest.startsWith(`${id}:`) && id.length > (owner?.length ?? -1)) {
      owner = id;
    }
  }
  if (owner !== undefined) {
    return owner;
  }
  const colon = rest.indexOf(':');
  return colon > 0 ? rest.slice(0, colon) : undefined;
}

const PARTS: Record<string, ExecutionPart> = {
  snapshot: ExecutionPart.Snapshot,
  ledger: ExecutionPart.Ledger,
  trail: ExecutionPart.Trail,
  held: ExecutionPart.Held,
  intent: ExecutionPart.Intent,
  pending: ExecutionPart.Pending,
  child: ExecutionPart.Child,
};

function toPart(name: string): ExecutionPart {
  return PARTS[name] ?? ExecutionPart.Other;
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

/** A child a forgotten run had a subprocess adapter run out of process. */
interface LinkedChild {
  readonly childId: string;
  /** Undefined when the link does not read: then whether it finished is unknown. */
  readonly link: ChildLink | undefined;
}

/** What a forget covers: the executions, and the links that brought in their children. */
interface Covered {
  readonly executions: Set<string>;
  readonly children: LinkedChild[];
}

/**
 * `executionIds` and every execution they had run out of process, their children's
 * included, in the order found: each run before its children.
 */
async function withChildren(
  host: ForgetHost,
  executionIds: ReadonlyArray<string>,
): Promise<Covered> {
  const executions = new Set<string>();
  const children: LinkedChild[] = [];
  const queue = [
    ...executionIds,
  ];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (executions.has(next)) {
      continue;
    }
    executions.add(next);
    for (const child of await linksOf(host.storage, next)) {
      if (!children.some((known) => known.childId === child.childId)) {
        children.push(child);
      }
      queue.push(child.childId);
    }
  }
  return {
    executions,
    children,
  };
}

/** The children the run rooted at `executionId` linked, with their links. */
async function linksOf(
  storage: StorageAdapter | undefined,
  executionId: string,
): Promise<LinkedChild[]> {
  if (!storage) {
    return [];
  }
  const keys = parseExecutionKeys(
    await storage.list(`${EXECUTION_PREFIX}${executionId}:child:`),
  ).filter(
    (parsed) =>
      parsed.executionId === executionId && parsed.part === ExecutionPart.Child && parsed.tail,
  );
  const values = await storageGetMany<unknown>(
    storage,
    keys.map((parsed) => parsed.key),
  );
  return keys.map((parsed) => {
    const link = ChildLinkSchema.safeParse(values.get(parsed.key));
    return {
      childId: parsed.tail ?? '',
      link: link.success ? link.data : undefined,
    };
  });
}

/** The adapter that ran `child`, as far as this harness can tell. */
function runnerOf(host: ForgetHost, child: LinkedChild): SubprocessAdapter | undefined {
  const dispatched = adapterOfChild(host.harness, child.childId);
  if (dispatched) {
    return dispatched;
  }
  if (child.link?.from === ChildAdapterSource.Harness) {
    return host.subprocess;
  }
  if (child.link?.from === ChildAdapterSource.Step) {
    const step = lookupStep(child.link.stepId);
    return step && (step.kind === 'runCode' || step.kind === 'spawn') ? step.subprocess : undefined;
  }
  return undefined;
}

/** Stop every handle `adapter` still runs for a covered execution. Resolves the executions it stopped. */
async function stopLive(
  adapter: SubprocessAdapter,
  executions: ReadonlySet<string>,
): Promise<Set<string>> {
  const stopped = new Set<string>();
  for (const handle of await adapter.listLive()) {
    const executionId = handle.metadata?.executionId;
    if (typeof executionId === 'string' && executions.has(executionId)) {
      await adapter.stop(handle.id, 'forgotten');
      stopped.add(executionId);
    }
  }
  return stopped;
}

/**
 * Stop every covered execution still running out of process, before anything of it
 * is settled or deleted: one that kept running would spend, and write again under
 * what the forget deletes. A child that has not finished is asked of the adapter
 * that ran it. When no adapter this harness knows of can be that one, and the host
 * named none in `subprocesses`, the forget is refused.
 *
 * @throws NoeticConfigError `FORGET_CHILD_UNREACHABLE`
 */
async function stopChildren(
  host: ForgetHost,
  covered: Covered,
  named: ReadonlyArray<SubprocessAdapter>,
): Promise<void> {
  const unfinished = covered.children.filter((child) => child.link?.settled !== true);
  const runners = new Map<string, SubprocessAdapter | undefined>(
    unfinished.map((child) => [
      child.childId,
      runnerOf(host, child),
    ]),
  );
  const unreachable = unfinished.filter((child) => runners.get(child.childId) === undefined);
  if (unreachable.length > 0 && named.length === 0) {
    throw childUnreachable(unreachable);
  }
  const adapters = new Set<SubprocessAdapter>([
    host.subprocess,
    ...adaptersUsedBy(host.harness),
    ...named,
  ]);
  for (const runner of runners.values()) {
    if (runner) {
      adapters.add(runner);
    }
  }
  for (const adapter of adapters) {
    if (!runsInProcess(adapter)) {
      await stopLive(adapter, covered.executions);
    }
  }
}

function childUnreachable(children: ReadonlyArray<LinkedChild>): NoeticConfigError {
  const named = children
    .map((child) => `"${child.childId}" (step "${child.link?.stepId ?? 'unknown'}")`)
    .join(', ');
  return new NoeticConfigError({
    code: 'FORGET_CHILD_UNREACHABLE',
    message: `Cannot tell whether ${named} still runs: the subprocess adapter that ran it is not known to this harness.`,
    hint: 'Pass that adapter in forget(scope, { subprocesses: [adapter] }) so a child still running is stopped before what it kept is deleted.',
  });
}

/** Delete everything stored for the executions, checking the lease between them. */
async function forgetExecutionState(
  host: ForgetHost,
  executionIds: ReadonlyArray<string>,
  under: {
    keepTrail: boolean;
    lease?: TurnLease;
  },
): Promise<void> {
  const storage = host.storage;
  for (const executionId of executionIds) {
    under.lease?.assert();
    await host.releaseConnections(executionId);
    await host.clearCheckpoint(executionId);
    if (!storage) {
      continue;
    }
    const keys = parseExecutionKeys(await storage.list(`${EXECUTION_PREFIX}${executionId}:`))
      .filter(
        (parsed) =>
          parsed.executionId === executionId &&
          !(under.keepTrail && parsed.part === ExecutionPart.Trail),
      )
      .map((parsed) => parsed.key);
    await deleteAll(storage, keys);
  }
  // Pool leases a crashed run left: no harness holds them to release.
  if (storage) {
    under.lease?.assert();
    await deleteAll(storage, await poolLeasesOf(storage, new Set(executionIds)));
  }
}

/**
 * Delete the state each of `layerIds` keeps at the thread's scope key. A key under
 * `layers/<id>/a/` may be thread `a`'s or, as `layers/<id>/a/b/`, thread `a/b`'s: keys
 * under another stored thread's scope key are left to that thread.
 */
async function forgetLayerState(
  host: ForgetHost,
  threadId: string,
  layerIds: ReadonlySet<string>,
): Promise<void> {
  const storage = host.storage;
  if (!storage || layerIds.size === 0) {
    return;
  }
  const nested = (
    await listStoredThreads(host, {
      prefix: `${threadId}/`,
    })
  ).map((other) => `${other}/`);
  for (const layerId of layerIds) {
    const scope = `${LAYERS_PREFIX}${layerId}/${threadId}/`;
    const keys = (await storage.list(scope)).filter((key) => {
      const rest = key.slice(scope.length - threadId.length - 1);
      return !nested.some((other) => rest.startsWith(other));
    });
    await deleteAll(storage, keys);
  }
}

/** The thread's stored record, or undefined when it has none or it does not read. */
async function recordOf(host: ForgetHost, threadId: string): Promise<SessionRecord | undefined> {
  return host.sessionStore?.load(threadId);
}

/** Refuse a thread with a turn running, or about to run, in this harness. */
function refuseBusy(host: ForgetHost, threadId: string, record: SessionRecord | undefined): void {
  const live = executionsOf(record).find((id) => host.executionBusy(id));
  if (host.threadBusy(threadId) || live !== undefined) {
    throw busy(threadId, `thread "${threadId}" has a turn running in this harness`);
  }
}

/**
 * Take the thread's lease, waiting up to `waitMs` for another harness's, and keep it
 * renewed until the forget is done. Taking it raises its term, so a harness that
 * stalled mid-turn loses its next write.
 */
async function holdThread(
  host: ForgetHost,
  threadId: string,
  under: {
    record: SessionRecord | undefined;
    waitMs: number;
  },
): Promise<TurnLease | undefined> {
  if (!host.leaseOptions) {
    return undefined;
  }
  const lease = await TurnLease.take(
    {
      ...host.leaseOptions,
      waitMs: under.waitMs,
    },
    threadId,
    {
      above: under.record?.term,
    },
  );
  // A lost lease is found by `assert` and `verify` before the next delete.
  lease.keep(() => undefined);
  return lease;
}

/** Every layer id whose state may be kept for the thread. */
function layerIdsFor(
  host: ForgetHost,
  records: ReadonlyArray<SessionRecord | undefined>,
): Set<string> {
  const ids = new Set(host.layerIds());
  for (const record of records) {
    for (const id of record?.layers ?? []) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * @internal
 * Forget a thread: settle its spend, then delete its executions, layer state,
 * display output, record and lease, in that order, holding the lease throughout.
 * The caller keeps new turns of the thread from starting in this harness meanwhile.
 */
export async function forgetThread(
  host: ForgetHost,
  threadId: string,
  options: ForgetOptions = {},
): Promise<ForgetReport> {
  const before = await recordOf(host, threadId);
  refuseBusy(host, threadId, before);
  const lease = await holdThread(host, threadId, {
    record: before,
    waitMs: options.waitMs ?? 0,
  });
  try {
    const report = await forgetHeldThread(host, threadId, {
      options,
      before,
      lease,
    });
    return report;
  } catch (error) {
    await lease?.release();
    throw error;
  }
}

async function forgetHeldThread(
  host: ForgetHost,
  threadId: string,
  held: {
    options: ForgetOptions;
    before: SessionRecord | undefined;
    lease: TurnLease | undefined;
  },
): Promise<ForgetReport> {
  const { options, before, lease } = held;
  const covered = await withChildren(host, executionsOf(before));
  await stopChildren(host, covered, options.subprocesses ?? []);
  const executions = covered.executions;
  const spend = await host.closeSpend(
    (record) =>
      record.threadId === threadId ||
      (record.executionId !== undefined && executions.has(record.executionId)),
    options.patienceMs,
  );
  await lease?.verify();
  // A turn may have begun before the lease was taken: read the record again under it.
  const after = await recordOf(host, threadId);
  refuseBusy(host, threadId, after);
  const again = await withChildren(host, executionsOf(after));
  const added = [
    ...again.executions,
  ].filter((executionId) => !executions.has(executionId));
  if (added.length > 0) {
    await stopChildren(host, again, options.subprocesses ?? []);
    spend.push(
      ...(await host.closeSpend(
        (record) => record.executionId !== undefined && added.includes(record.executionId),
        options.patienceMs,
      )),
    );
  }
  const executionIds = [
    ...executions,
    ...added,
  ];
  host.dropThread(threadId);
  await forgetExecutionState(host, executionIds, {
    keepTrail: options.keepTrail === true,
    lease,
  });
  await forgetLayerState(
    host,
    threadId,
    layerIdsFor(host, [
      before,
      after,
    ]),
  );
  await host.settleOutput(threadId);
  await host.outputStorage.delete(outputKey(threadId));
  await lease?.verify();
  if (host.storage) {
    await host.storage.delete(sessionKey(threadId));
  }
  // The lease goes last, while still held: a forget cut off before this leaves the thread listed.
  await lease?.stop();
  await lease?.verify();
  await host.storage?.delete(leaseKey(threadId));
  return {
    threadId,
    executionIds,
    spend,
  };
}

/**
 * @internal
 * Forget one execution: settle its spend, then delete everything under
 * `execution:<id>:`. A thread's record is left alone.
 */
export async function forgetExecution(
  host: ForgetHost,
  executionId: string,
  options: ForgetOptions = {},
): Promise<ForgetReport> {
  const covered = await withChildren(host, [
    executionId,
  ]);
  const executions = covered.executions;
  const live = [
    ...executions,
  ].find((id) => host.executionBusy(id));
  if (live !== undefined) {
    throw busy(live, `execution "${live}" has a run in flight in this harness`);
  }
  await stopChildren(host, covered, options.subprocesses ?? []);
  const spend = await host.closeSpend(
    (record) => record.executionId !== undefined && executions.has(record.executionId),
    options.patienceMs,
  );
  const executionIds = [
    ...executions,
  ];
  await forgetExecutionState(host, executionIds, {
    keepTrail: options.keepTrail === true,
  });
  return {
    executionIds,
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
  const keys = (await host.storage?.list(`${EXECUTION_PREFIX}${prefix}`)) ?? [];
  for (const parsed of parseExecutionKeys(keys)) {
    add(parsed.executionId, parsed.part);
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
