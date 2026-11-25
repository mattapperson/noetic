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
import { emitFrameworkEvent, getBroadcaster } from './broadcaster-utils';
import { ContextImpl } from './context-impl';

//#region Types

/** The plan last told for one layer of one execution: a hash of it, and its id. */
interface Told {
  readonly hash: string;
  readonly id?: string;
}

/** One execution whose layers keep a plan: where to tell it, and which layers. */
interface Watched {
  readonly ctx: Context;
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
   * the layers' `init`, so a plan it restores is told too. Layers added later
   * (a `withContext` step) join the execution's set.
   */
  watch(ctx: Context, layers: ReadonlyArray<ContextLayer> | undefined): void {
    const planned = (layers ?? []).filter((layer) => layer.plan !== undefined);
    if (planned.length === 0) {
      return;
    }
    const existing = this.watched.get(ctx.id);
    const entry: Watched = existing ?? {
      ctx,
      layers: new Map(),
      told: new Map(),
    };
    for (const layer of planned) {
      entry.layers.set(layer.id, layer);
    }
    this.watched.set(ctx.id, entry);
  }

  /** The execution's layers are gone: tell nothing more for it. */
  forget(executionId: string): void {
    this.watched.delete(executionId);
  }

  /** A layer's state was written: tell its plan if it changed. */
  changed(executionId: string, layerId: string, state: unknown): void {
    const entry = this.watched.get(executionId);
    const layer = entry?.layers.get(layerId);
    if (!entry || !layer) {
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
      this.emit(entry.ctx, 'plan_removed', idData(last.id));
    }
    if (plan === null || hash === undefined) {
      entry.told.delete(layerId);
      return;
    }
    entry.told.set(layerId, {
      hash,
      ...idData(plan.id),
    });
    this.emit(entry.ctx, 'plan_updated', {
      plan,
    });
  }

  private emit(ctx: Context, eventType: string, data: Record<string, unknown>): void {
    emitFrameworkEvent({
      broadcaster: getBroadcaster(ctx),
      agentName: ctx.harness.config.name,
      eventType,
      data: {
        ...stepData(ctx),
        ...data,
      },
    });
  }
}

/** `store`, telling `reporter` of every write as it lands. */
export function reportingLayerPlans(
  store: LayerStateStore,
  reporter: LayerPlanReporter,
): LayerStateStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === 'set') {
        return <T>(executionId: string, layerId: string, state: T): void => {
          target.set(executionId, layerId, state);
          reporter.changed(executionId, layerId, state);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

//#endregion
