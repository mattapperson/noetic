import type { LayerStateStore } from '@noetic-tools/context';
import type { Context, Item, ItemSchemaRegistry, RestoreContextOptions } from '@noetic-tools/types';
import type { CheckpointSnapshot, FrontierFrame } from '../../types/checkpoint';
import { CheckpointSchemaVersion } from '../../types/checkpoint';
import type { ChannelStore } from '../channel-store';
import { ContextImpl, rootIdOf } from '../context-impl';
import type { EventBroadcaster } from '../event-broadcaster';
import type { CheckpointStore } from './checkpoint-store';
import type { StepLedgerRetention, StepLedgerStore, StepLedgerWindow } from './step-ledger';
import { StepLedger } from './step-ledger';

//#region Handle interface

/**
 * Host wiring forwarded into the context `restoreFromCheckpoint` builds.
 * `RestoreContextOptions` covers the portable fields; core widens it with the
 * internal `_broadcaster` seam so a resumed turn keeps streaming framework UI
 * events.
 *
 * @internal
 */
export type RestoreCheckpointOptions = RestoreContextOptions & {
  /** @internal Event broadcaster the host attached to the original context. */
  _broadcaster?: EventBroadcaster;
};

/**
 * Minimum harness surface `captureCheckpoint` / `restoreFromCheckpoint`
 * require. `AgentHarness` already satisfies this shape via its
 * `@internal` readonly fields — defining it structurally keeps the free
 * functions loosely coupled to the harness implementation.
 *
 * @internal
 */
export interface CheckpointHarnessHandle {
  readonly checkpointStore?: CheckpointStore;
  readonly stepLedgerStore?: StepLedgerStore;
  readonly stepLedgerRetention?: StepLedgerRetention;
  readonly layerStateStore: LayerStateStore;
  readonly channelStore: Pick<ChannelStore, 'snapshot' | 'restore'>;
  readonly itemSchemas: ItemSchemaRegistry;
  createContext(
    opts?: RestoreCheckpointOptions & {
      items?: Item[];
      threadId?: string;
      resourceId?: string;
      cwdInit?: string;
    },
  ): Context;
}

//#endregion

//#region captureCheckpoint

/**
 * Snapshot the execution state at a checkpoint boundary. No-op when no
 * `CheckpointStore` is configured — zero-config harnesses preserve
 * ephemeral semantics. Save failures are logged rather than thrown,
 * because a checkpoint failing must never abort an otherwise-successful
 * step.
 *
 * @internal
 */
export async function captureCheckpoint(h: CheckpointHarnessHandle, ctx: Context): Promise<void> {
  const store = h.checkpointStore;
  if (!store) {
    return;
  }
  const impl = ctx instanceof ContextImpl ? ctx : null;
  const frontier: FrontierFrame[] = impl ? impl.serialiseFrontier() : [];
  const layers: Record<string, unknown> = {};
  for (const layer of ctx.layers ?? []) {
    const state = h.layerStateStore.get<unknown>(ctx.id, layer.id);
    if (state !== undefined) {
      layers[layer.id] = state;
    }
  }
  const snapshot: CheckpointSnapshot = {
    schemaVersion: CheckpointSchemaVersion,
    executionId: ctx.id,
    threadId: ctx.threadId,
    resourceId: ctx.resourceId,
    frontier,
    layers,
    cwd: {
      current: ctx.cwdState.cwd,
      previous: ctx.cwdState.previousCwd,
    },
    // Ask-user queue snapshot is empty at the core layer — the code-agent
    // host is responsible for pushing pending prompts through this store
    // via `AskUserService` integration. Carrying the shape from day one
    // means future producers don't bump the schema version.
    askUser: [],
    itemLog: {
      items: [
        ...ctx.itemLog.items,
      ],
    },
    // Channel state belongs to the root execution, so a child checkpoint
    // carries the channels its root used.
    channels: h.channelStore.snapshot(rootIdOf(ctx)),
    capturedAt: new Date().toISOString(),
  };
  try {
    await store.save(snapshot);
  } catch (err) {
    console.warn(
      `AgentHarness.checkpoint: failed to persist snapshot for execution "${ctx.id}":`,
      err,
    );
  }
}

//#endregion

//#region restoreFromCheckpoint

/**
 * What `restoreFromCheckpoint` rebuilt. `fromSnapshot` is false for a ledger-only
 * restore, whose layer state was never recovered — the harness must then let layer
 * `init` hydrate normally instead of keeping restored state.
 *
 * @internal
 */
export interface RestoredExecution {
  ctx: Context;
  fromSnapshot: boolean;
}

/**
 * Rebuild a `Context` for `executionId` from what a previous run recorded: the
 * checkpoint snapshot and the step-completion ledger. Either is enough. Returns
 * `null` only when neither exists, so the caller starts a fresh execution.
 *
 * - With a snapshot, the item log, layer state, channel state, cwd, and thread/resource
 *   ids come from it. Layer state is replayed into `layerStateStore` under the original
 *   id; channel values and queued items refill the channel store for channels with no
 *   live state.
 * - Without one, the context starts like `createContext(opts)` would — empty item
 *   log, no layer or channel state, the harness's root cwd, fresh thread id — and only
 *   its identity and ledger are recovered. Recorded steps replay; the rest run fresh.
 *
 * `opts` carries the host's own context wiring (broadcaster, parent, state, layer
 * overrides). A snapshot cannot round-trip live objects, so a host that decorated
 * the original context has to hand the same decoration back here. Snapshot-owned
 * fields always win: identity, item log, and cwd come from the persisted record,
 * never from `opts`.
 *
 * A snapshot whose schema version is unknown throws
 * `NoeticConfigError(CHECKPOINT_SCHEMA_MISMATCH)` from the store; the ledger is not
 * used as a fallback, because resuming onto it would drop state the snapshot held.
 *
 * @internal
 */
export async function restoreFromCheckpoint(
  h: CheckpointHarnessHandle,
  executionId: string,
  opts?: RestoreCheckpointOptions,
): Promise<RestoredExecution | null> {
  const store = h.checkpointStore;
  if (!store) {
    return null;
  }
  const snapshot = await store.load(executionId);
  const recovered = await h.stepLedgerStore?.load(executionId);
  if (!snapshot && (!recovered || recovered.entries.size === 0)) {
    return null;
  }
  const ctx = snapshot ? contextFromSnapshot(h, snapshot, opts) : h.createContext(opts);
  if (ctx instanceof ContextImpl) {
    adoptExecution({
      h,
      ctx,
      executionId,
      recovered,
    });
  }
  return {
    ctx,
    fromSnapshot: snapshot !== null,
  };
}

/** Replay a snapshot's layer and channel state and build the context its item log and cwd describe. */
function contextFromSnapshot(
  h: CheckpointHarnessHandle,
  snapshot: CheckpointSnapshot,
  opts: RestoreCheckpointOptions | undefined,
): Context {
  for (const [layerId, state] of Object.entries(snapshot.layers)) {
    h.layerStateStore.set(snapshot.executionId, layerId, state);
  }
  h.channelStore.restore(snapshot.executionId, snapshot.channels ?? []);
  /* Caller wiring first, snapshot second: a host may legitimately swap the context
   * layers or hang the restored execution under a new parent, but it must never be
   * able to override the identity/history the snapshot is the record of. */
  return h.createContext({
    ...opts,
    items: h.itemSchemas.parseMany(snapshot.itemLog.items),
    threadId: snapshot.threadId,
    resourceId: snapshot.resourceId,
    cwdInit: snapshot.cwd?.current ?? undefined,
  });
}

/**
 * Give `ctx` the original execution id and the ledger recorded under it.
 * `createContext` already built a fresh ledger keyed to a throwaway id; without the
 * recovered one `execute()` would replay nothing and re-run the whole tree. Both are
 * assigned with `defineProperty` to keep `createContext`'s public options free of
 * resume-only fields — adapter correlation across a restart needs the stable id.
 */
function adoptExecution({
  h,
  ctx,
  executionId,
  recovered,
}: {
  h: CheckpointHarnessHandle;
  ctx: ContextImpl;
  executionId: string;
  recovered: StepLedgerWindow | undefined;
}): void {
  Object.defineProperty(ctx, 'id', {
    value: executionId,
    configurable: false,
    writable: false,
    enumerable: true,
  });
  if (!h.stepLedgerStore || !recovered) {
    return;
  }
  Object.defineProperty(ctx, 'ledger', {
    value: new StepLedger({
      executionId,
      store: h.stepLedgerStore,
      recovered,
      retention: h.stepLedgerRetention,
    }),
    configurable: false,
    writable: false,
    enumerable: true,
  });
}

//#endregion

//#region clearCheckpoint

/**
 * Discard every recovery record for one execution: the snapshot and the completion
 * ledger. Clearing the snapshot alone would strand the ledger's shards under
 * `execution:<id>:ledger:*` forever, since nothing else enumerates them.
 *
 * This is the operation a host performs when resume is no longer valid — most often
 * because the workflow changed. Replay happens at the coarsest completed granularity,
 * so a step edited *beneath* a recorded parent is invisible to divergence detection and
 * the old output would be replayed over the new tree. Clear, then start fresh.
 *
 * @internal
 */
export async function clearCheckpoint(
  h: CheckpointHarnessHandle,
  executionId: string,
): Promise<void> {
  await h.checkpointStore?.clear(executionId);
  await h.stepLedgerStore?.clear(executionId);
}

//#endregion
