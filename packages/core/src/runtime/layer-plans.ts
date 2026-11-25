/**
 * A context layer that keeps the agent's plan (`ContextLayer.plan`) reports
 * it with the events an agent step's agent reports its plan with:
 * `plan_updated` when it changes, `plan_removed` when it goes (spec 08
 * § Tool calls, plans and agent settings). The harness reads each such layer's
 * plan after every tool call, since a plan changes only through the layer's
 * tools, and tells each change once.
 */

import type { AgentHarnessContract, AgentPlan, Context, ContextLayer } from '@noetic-tools/types';
import { hashString } from '@noetic-tools/types';
import { ContextImpl } from './context-impl';

//#region Types

/** The plan last told for one layer of one execution: a hash of it, and its id. */
interface Told {
  readonly hash: string;
  readonly id?: string;
}

/** Parameters for {@link reportLayerPlans}. */
export interface ReportLayerPlansParams {
  ctx: Context;
  layers: ReadonlyArray<ContextLayer> | undefined;
  /** Emits one framework event, through the step's `emit` filter. */
  emit: (eventType: string, data: Record<string, unknown>) => void;
}

//#endregion

//#region Helpers

/** What each harness last told, by execution and layer. */
const TOLD = new WeakMap<AgentHarnessContract, Map<string, Told>>();

function toldFor(harness: AgentHarnessContract): Map<string, Told> {
  const known = TOLD.get(harness);
  if (known) {
    return known;
  }
  const told = new Map<string, Told>();
  TOLD.set(harness, told);
  return told;
}

/** The layer's plan now; null when it holds none, or its `plan` throws. */
function currentPlan(layer: ContextLayer, ctx: Context): AgentPlan | null {
  const read = layer.plan;
  const state = ctx.harness.getLayerState(ctx.id, layer.id);
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

/** Tell each change of the plans the step's layers keep, once. */
export function reportLayerPlans(params: ReportLayerPlansParams): void {
  const { ctx, layers, emit } = params;
  const planned = (layers ?? []).filter((layer) => layer.plan !== undefined);
  if (planned.length === 0) {
    return;
  }
  const told = toldFor(ctx.harness);
  for (const layer of planned) {
    const key = `${ctx.id}\u0000${layer.id}`;
    const last = told.get(key);
    const plan = currentPlan(layer, ctx);
    const hash = plan === null ? undefined : hashString(JSON.stringify(plan));
    if (hash === last?.hash) {
      continue;
    }
    // Another plan, or none, in place of the one told: that one is gone.
    if (last && (plan === null || plan.id !== last.id)) {
      emit('plan_removed', {
        ...stepData(ctx),
        ...idData(last.id),
      });
    }
    if (plan === null || hash === undefined) {
      told.delete(key);
      continue;
    }
    told.set(key, {
      hash,
      ...idData(plan.id),
    });
    emit('plan_updated', {
      ...stepData(ctx),
      plan,
    });
  }
}

//#endregion
