import type { Context } from '../../types/context';
import type { MemoryLayer } from '../../types/memory';
import type { Item } from '../../types/items';
import type { CheckpointSnapshot, FrontierFrame } from '../../types/checkpoint';
import { CheckpointSchemaVersion } from '../../types/checkpoint';
import type { ItemSchemaRegistry } from '../../schemas/item';
import { ContextImpl } from '../context-impl';
import type { LayerStateStore } from '../../memory/layer-lifecycle';
import type { CheckpointStore } from './checkpoint-store';

//#region Handle interface

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
  readonly layerStateStore: LayerStateStore;
  readonly itemSchemas: ItemSchemaRegistry;
  readonly _memory?: MemoryLayer[];
  createContext(opts?: {
    items?: Item[];
    threadId?: string;
    resourceId?: string;
    cwdInit?: string;
    memory?: MemoryLayer[];
  }): Context;
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
export async function captureCheckpoint(
  h: CheckpointHarnessHandle,
  ctx: Context,
): Promise<void> {
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
 * `readLayerState` and the memory projectors.
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
  const ctx = h.createContext({
    items,
    threadId: snapshot.threadId,
    resourceId: snapshot.resourceId,
    cwdInit,
    memory: h._memory,
  });
  if (ctx instanceof ContextImpl) {
    Object.defineProperty(ctx, 'id', {
      value: executionId,
      configurable: false,
      writable: false,
      enumerable: true,
    });
  }
  return ctx;
}

//#endregion
