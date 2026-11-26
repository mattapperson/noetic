/**
 * A context layer that keeps the agent's plan (`ContextLayer.plan`) reports
 * it live, with the events an agent step's agent reports its plan with:
 * `plan_updated` the moment the layer's state changes its plan, `plan_removed`
 * when the plan goes (spec 08 § Tool calls, plans and agent settings).
 *
 * The harness wraps its layer-state store with {@link reportingLayerPlans}, so
 * every write — a layer tool a model or an agent calls, a code step's layer
 * function, a `store()` hook, `init` restoring a plan — is seen as it lands.
 * An execution's layers are known from when they are initialized
 * ({@link LayerPlanReporter.watch}) until they are disposed.
 */

import type { LayerStateStore } from '@noetic-tools/context';
import type { AgentPlan, Context, ContextLayer } from '@noetic-tools/types';
import { hashString } from '@noetic-tools/types';
import { harnessInternal } from '../util/harness-internals';
import { emitFrameworkEvent, getBroadcaster, shouldEmit } from './broadcaster-utils';
import { ContextImpl } from './context-impl';

//#region Types

/** The plan last told for one layer of one execution: a hash of it, and its id. */
interface Told {
  readonly hash: string;
  readonly id?: string;
}

/** A context, held weakly where the runtime can (not every one has `WeakRef`). */
interface HeldContext {
  deref(): Context | undefined;
}

/**
 * One execution whose layers keep a plan: where to tell it, and which layers.
 * The context is held weakly, so a finished execution's context — its item
 * log, its broadcaster — is never kept alive by its plan; the entry goes when
 * the context does, or when the execution's layers are cleaned up.
 */
interface Watched {
  readonly ctx: HeldContext;
  readonly layers: Map<string, ContextLayer>;
  readonly told: Map<string, Told>;
}

//#endregion

//#region Helpers

/** The layer's plan in `state`; null when it holds none, or its `plan` throws. */
function planIn(layer: ContextLayer, state: unknown): AgentPlan | null {
  const read = layer.plan;
  if (!read || state === undefined) {
    return null;
  }
  try {
    return read(state);
  } catch {
    return null;
  }
}

/**
 * Hold `ctx` weakly, so a finished execution's context is not kept alive by
 * its plan; a runtime without `WeakRef` holds it until the execution's layer
 * state is cleaned up.
 */
function holdWeakly(ctx: Context): HeldContext {
  if (typeof WeakRef === 'function') {
    return new WeakRef(ctx);
  }
  return {
    deref: () => ctx,
  };
}

/** Where the plan is: the step running, when the context knows it. */
function stepData(ctx: Context): Record<string, string> {
  const stepId = ctx instanceof ContextImpl ? ctx.currentDispatch()?.stepId : undefined;
  return stepId === undefined
    ? {}
    : {
        stepId,
      };
}

function idData(id: string | undefined): Record<string, string> {
  return id === undefined
    ? {}
    : {
        id,
      };
}

//#endregion

//#region Public API

/** Tells each change of the plans an execution's layers keep, once, as it lands. */
export class LayerPlanReporter {
  private readonly watched = new Map<string, Watched>();

  /**
   * Start telling the plans `layers` keep for `ctx`'s execution. Call before
   * the layers' `init`, so the plan `init` writes is told; a plan already in
   * the store (a restored execution's) is told at once. Layers added later (a
   * `withContext` step) join the execution's set.
   */
  watch(ctx: Context, layers: ReadonlyArray<ContextLayer> | undefined): void {
    const planned = (layers ?? []).filter((layer) => layer.plan !== undefined);
    if (planned.length === 0) {
      return;
    }
    const entry = this.entryFor(ctx);
    for (const layer of planned) {
      if (entry.layers.has(layer.id)) {
        continue;
      }
      entry.layers.set(layer.id, layer);
      this.changed(ctx.id, layer.id, ctx.harness.getLayerState(ctx.id, layer.id));
    }
  }

  /** The execution's layers are gone: tell nothing more for it. */
  forget(executionId: string): void {
    this.watched.delete(executionId);
  }

  /** One layer of the execution is gone: forget it and what was told of it. */
  drop(executionId: string, layerId: string): void {
    const entry = this.watched.get(executionId);
    entry?.layers.delete(layerId);
    entry?.told.delete(layerId);
  }

  /** A layer's state was written: tell its plan if it changed. */
  changed(executionId: string, layerId: string, state: unknown): void {
    const entry = this.watched.get(executionId);
    const layer = entry?.layers.get(layerId);
    const ctx = entry?.ctx.deref();
    if (!entry || !layer || !ctx) {
      return;
    }
    const plan = planIn(layer, state);
    const hash = plan === null ? undefined : hashString(JSON.stringify(plan));
    const last = entry.told.get(layerId);
    if (hash === last?.hash) {
      return;
    }
    // Another plan, or none, in place of the one told: that one is gone.
    if (last && (plan === null || plan.id !== last.id)) {
      this.emit(ctx, layer, 'plan_removed', idData(last.id));
    }
    if (plan === null || hash === undefined) {
      entry.told.delete(layerId);
      return;
    }
    entry.told.set(layerId, {
      hash,
      ...idData(plan.id),
    });
    this.emit(ctx, layer, 'plan_updated', {
      plan,
    });
  }

  /** The execution's entry, for this context: a new context under a known id starts afresh. */
  private entryFor(ctx: Context): Watched {
    const existing = this.watched.get(ctx.id);
    if (existing && existing.ctx.deref() === ctx) {
      return existing;
    }
    // A new execution is the moment to let go of the ones whose context is gone.
    this.sweep();
    const entry: Watched = {
      ctx: holdWeakly(ctx),
      layers: new Map(),
      told: new Map(),
    };
    this.watched.set(ctx.id, entry);
    return entry;
  }

  /** Forget every execution whose context was collected. */
  private sweep(): void {
    for (const [executionId, entry] of this.watched) {
      if (entry.ctx.deref() === undefined) {
        this.watched.delete(executionId);
      }
    }
  }

  /** How many executions are watched: for tests that check nothing is kept. */
  get size(): number {
    return this.watched.size;
  }

  /** One event of `layer`'s, through the layer's own `emit` filter. */
  private emit(
    ctx: Context,
    layer: ContextLayer,
    eventType: string,
    data: Record<string, unknown>,
  ): void {
    const payload = {
      ...stepData(ctx),
      ...data,
    };
    if (!shouldEmit(layer.emit, eventType, payload)) {
      return;
    }
    emitFrameworkEvent({
      broadcaster: getBroadcaster(ctx),
      agentName: ctx.harness.config.name,
      eventType,
      data: payload,
    });
  }
}

/**
 * Watch the plans `layers` keep for `ctx`'s execution, through the harness's
 * reporter: for layers that start inside a run (a `withContext` step, a spawned
 * child) rather than with it.
 */
export function watchLayerPlans(
  ctx: Context,
  layers: ReadonlyArray<ContextLayer> | undefined,
): void {
  harnessInternal<LayerPlanReporter>(ctx.harness, 'layerPlans')?.watch(ctx, layers);
}

/**
 * `store`, telling `reporter` of every write as it lands. A plain object over
 * the store, not a Proxy: a host that decorates the harness's store by
 * replacing its `set` (the inspector does) wraps this `set`, and this one
 * calls the store's own — never back into the decoration.
 */
export function reportingLayerPlans(
  store: LayerStateStore,
  reporter: LayerPlanReporter,
): LayerStateStore {
  const set = store.set.bind(store);
  const cleanup = store.cleanup.bind(store);
  const drop = store.drop?.bind(store);
  const reporting: LayerStateStore = Object.create(store);
  reporting.set = <T>(executionId: string, layerId: string, state: T): void => {
    set(executionId, layerId, state);
    reporter.changed(executionId, layerId, state);
  };
  reporting.cleanup = (executionId: string): void => {
    cleanup(executionId);
    reporter.forget(executionId);
  };
  if (drop) {
    reporting.drop = (executionId: string, layerId: string): void => {
      drop(executionId, layerId);
      reporter.drop(executionId, layerId);
    };
  }
  return reporting;
}

//#endregion
