import type { LayerStateStore } from '@noetic-tools/context';
import type { Context, Item, ItemSchemaRegistry, RestoreContextOptions } from '@noetic-tools/types';
import type { CheckpointSnapshot, FrontierFrame } from '../../types/checkpoint';
import { CheckpointSchemaVersion } from '../../types/checkpoint';
import type { EventBroadcaster } from '../../util/event-broadcaster';
import { ContextImpl } from '../context-impl';
import type { CheckpointStore } from './checkpoint-store';
import type { StepLedgerRetention, StepLedgerStore } from './step-ledger';
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
 * Rebuild a `Context` from a previously-persisted snapshot. Returns
 * `null` if no snapshot is recorded for `executionId`. Layer state is
 * replayed into `layerStateStore` keyed by the original executionId so
 * the restored context observes the pre-crash state through
 * `readLayerState` and the context projectors.
 *
 * `opts` carries the host's own context wiring (broadcaster, parent, state,
 * layer overrides) into the rebuilt context. A snapshot cannot round-trip live
 * objects, so a host that decorated the original context has to hand the same
 * decoration back here — otherwise the resumed run gets a bare context and
 * whatever depended on that wiring stops working silently. Snapshot-owned
 * fields always win: identity, item log, and cwd come from the persisted
 * record, never from `opts`.
 *
 * Preserves the original executionId on the returned context via
 * `Object.defineProperty` — adapter correlation across crash/restart
 * requires a stable id.
 *
 * @internal
 */
export async function restoreFromCheckpoint(
  h: CheckpointHarnessHandle,
  executionId: string,
  opts?: RestoreCheckpointOptions,
): Promise<Context | null> {
  const store = h.checkpointStore;
  if (!store) {
    return null;
  }
  const snapshot = await store.load(executionId);
  if (!snapshot) {
    return null;
  }
  for (const [layerId, state] of Object.entries(snapshot.layers)) {
    h.layerStateStore.set(executionId, layerId, state);
  }
  const items: Item[] = h.itemSchemas.parseMany(snapshot.itemLog.items);
  const cwdInit = snapshot.cwd?.current ?? undefined;
  /* Caller wiring first, snapshot second: a host may legitimately swap the context
   * layers or hang the restored execution under a new parent, but it must never be
   * able to override the identity/history the snapshot is the record of. */
  const ctx = h.createContext({
    ...opts,
    items,
    threadId: snapshot.threadId,
    resourceId: snapshot.resourceId,
    cwdInit,
  });
  if (ctx instanceof ContextImpl) {
    Object.defineProperty(ctx, 'id', {
      value: executionId,
      configurable: false,
      writable: false,
      enumerable: true,
    });
    /* Attach the recovered completion ledger. `createContext` already built a fresh
     * one keyed to a throwaway id; the restored context needs the entries recorded
     * under THIS execution, or `execute()` would replay nothing and re-run the whole
     * tree. Assigned the same way `id` is, to keep `createContext`'s public options
     * free of resume-only fields. */
    if (h.stepLedgerStore) {
      const recovered = await h.stepLedgerStore.load(executionId);
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
  }
  return ctx;
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
