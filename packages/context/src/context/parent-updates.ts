/**
 * Live children and `onParentUpdate` delivery. A child execution is live from
 * the moment its spawn (or inParallel path) starts running until it returns or
 * is cleaned up. While it is live, every write of a parent layer's state is
 * handed to the same layer's `onParentUpdate` in the child.
 */

import type {
  ContextLayer,
  ExecutionContext,
  ItemLog,
  ItemSchemaRegistry,
} from '@noetic-tools/types';
import { defaultItemSchemaRegistry } from '@noetic-tools/types';
import { callHook } from './hook-call';

//#region Types

/** @public A running child execution that receives its parent's layer writes. */
export interface LiveChild {
  /** Execution whose layer writes the child receives. */
  parentExecutionId: string;
  /** The child's execution context; hooks run on it and trace onto its span. */
  ctx: ExecutionContext;
  /** The layers active in the child. */
  layers: ContextLayer[];
  /** The child's item log, where returned items are appended. */
  log: ItemLog;
  itemSchemas?: ItemSchemaRegistry;
}

/** The slice of the layer state store that delivery reads and writes through. */
export interface ParentUpdateStore {
  get<T>(executionId: string, layerId: string): T | undefined;
  set<T>(executionId: string, layerId: string, state: T): void;
  diagnostic: (layerId: string, hook: string, error: unknown) => void;
}

/** Whether a layer's hooks are switched off for an execution. */
type SkipCheck = (executionId: string, layer: ContextLayer) => boolean;

export interface LiveChildren {
  adopt(child: LiveChild): void;
  /** Hands a parent write to every live child of `parentExecutionId`. */
  notify(parentExecutionId: string, layerId: string, state: unknown): void;
  /** Stops new deliveries to a child and waits for the ones already running. */
  release(childExecutionId: string): Promise<void>;
  /** Forgets a child at once; a delivery still running discards its result. */
  drop(childExecutionId: string): void;
  /** Number of live children, for leak checks. */
  readonly size: number;
}

interface Entry {
  child: LiveChild;
  /** Deliveries for one child run one at a time, in write order. */
  queue: Promise<void>;
  /** False once released: queued deliveries are skipped. */
  open: boolean;
  /** True once dropped: results of running deliveries are discarded. */
  gone: boolean;
}

//#endregion

//#region Public API

const DEFAULT_TIMEOUT = 5e3;

/**
 * Builds the live-child registry a layer state store dispatches through.
 * `store` is read lazily, so it may be the object under construction.
 */
export function createLiveChildren(store: ParentUpdateStore, skips: SkipCheck): LiveChildren {
  const byChild = new Map<string, Entry>();
  const byParent = new Map<string, Set<Entry>>();

  function forget(childExecutionId: string): Entry | undefined {
    const entry = byChild.get(childExecutionId);
    if (!entry) {
      return undefined;
    }
    byChild.delete(childExecutionId);
    const siblings = byParent.get(entry.child.parentExecutionId);
    siblings?.delete(entry);
    if (siblings?.size === 0) {
      byParent.delete(entry.child.parentExecutionId);
    }
    entry.open = false;
    return entry;
  }

  return {
    adopt(child) {
      const entry: Entry = {
        child,
        queue: Promise.resolve(),
        open: true,
        gone: false,
      };
      byChild.set(child.ctx.executionId, entry);
      let siblings = byParent.get(child.parentExecutionId);
      if (!siblings) {
        siblings = new Set();
        byParent.set(child.parentExecutionId, siblings);
      }
      siblings.add(entry);
    },
    notify(parentExecutionId, layerId, state) {
      const siblings = byParent.get(parentExecutionId);
      if (!siblings) {
        return;
      }
      for (const entry of siblings) {
        const layer = entry.child.layers.find((l) => l.id === layerId);
        if (!layer?.hooks.onParentUpdate) {
          continue;
        }
        entry.queue = entry.queue.then(() =>
          deliver({
            entry,
            layer,
            parentState: state,
            store,
            skips,
          }),
        );
      }
    },
    async release(childExecutionId) {
      const entry = forget(childExecutionId);
      await entry?.queue;
    },
    drop(childExecutionId) {
      const entry = forget(childExecutionId);
      if (entry) {
        entry.gone = true;
      }
    },
    get size() {
      return byChild.size;
    },
  };
}

//#endregion

//#region Helpers

interface Delivery {
  entry: Entry;
  layer: ContextLayer;
  parentState: unknown;
  store: ParentUpdateStore;
  skips: SkipCheck;
}

/** Runs one `onParentUpdate` call. Never rejects: failures become diagnostics. */
async function deliver({ entry, layer, parentState, store, skips }: Delivery): Promise<void> {
  const { ctx, log, itemSchemas = defaultItemSchemaRegistry } = entry.child;
  const onParentUpdate = layer.hooks.onParentUpdate;
  if (!entry.open || !onParentUpdate || skips(ctx.executionId, layer)) {
    return;
  }
  try {
    const result = await callHook({
      ctx,
      layerId: layer.id,
      hook: 'onParentUpdate',
      timeout: layer.timeouts?.onParentUpdate ?? DEFAULT_TIMEOUT,
      run: () =>
        onParentUpdate({
          parentState,
          childState: store.get(ctx.executionId, layer.id),
          childCtx: ctx,
        }),
    });
    // A child cleaned up mid-call has no state left to write into.
    if (!result || entry.gone) {
      return;
    }
    if ('childState' in result) {
      store.set(ctx.executionId, layer.id, result.childState);
    }
    for (const item of itemSchemas.extend(layer.itemSchemas).parseMany(result.items ?? [])) {
      log.append(item);
    }
  } catch (e) {
    store.diagnostic(layer.id, 'onParentUpdate', e);
  }
}

//#endregion
