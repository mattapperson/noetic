/**
 * Daemon root flow — composes four periodic `every` steps (autopilot,
 * validator, health, reconcile) plus a cross-process events bridge into a
 * single `fork({ mode: 'all' })` wrapped in a `spawn({ memory })`.
 *
 * The whole tree is driven by `harness.detachedSpawn(buildTaskDaemonFlow(...), ...)`
 * from the daemon entry, so abort/observability/cost tracking/spans/memory-layer
 * lifecycle come for free.
 *
 * The events bridge is a 5th `every` that tails `_events.jsonl` and forwards
 * new events onto the in-process `externalTaskEventsChan`. External channels
 * are in-memory per-harness, so the agent-ci runner subprocess (which has no
 * harness) can't publish via channel handle directly. The durable record on
 * disk is the cross-process transport; this bridge step taps it for daemon
 * subscribers.
 *
 * Each sub-flow exports its own `buildXEvery` factory typed by its tick step's
 * output. The fork composition here re-wraps the autopilot and reconcile tick
 * steps in `every({...})` directly so all five paths share the `void, void`
 * shape that `fork({ mode: 'all' })` requires.
 */

import type { ContextMemory, Step } from '@noetic/core';
import { every, fork, spawn, step, workingMemory } from '@noetic/core';
import { z } from 'zod';

import { createSteeringFileLayer } from '../../../../memory/steering-file-layer.js';
import { externalTaskEventsChan, featureLoopStateChan, validatorRequestChan } from '../channels.js';
import type { TaskStoreContext } from '../fs-store.js';
import { tailEvents } from '../fs-store.js';
import type { AutopilotFlowDeps } from './autopilot-flow.js';
import { buildAutopilotTickStep } from './autopilot-flow.js';
import type { HealthFlowDeps } from './health-flow.js';
import { buildHealthTickStep } from './health-flow.js';
import type { ReconcileFlowDeps } from './reconcile-flow.js';
import { buildReconcileTickStep } from './reconcile-flow.js';
import type { ValidatorFlowDeps } from './validator-flow.js';
import { buildValidatorIterationStep } from './validator-flow.js';

//#region Constants

const AUTOPILOT_TICK_INTERVAL_MS = 60_000;
const VALIDATOR_TICK_INTERVAL_MS = 30_000;
const HEALTH_TICK_INTERVAL_MS = 5 * 60_000;
const RECONCILE_TICK_INTERVAL_MS = 60_000;
const EVENTS_BRIDGE_INTERVAL_MS = 1_000;

//#endregion

//#region Types

/**
 * Aggregate dependencies threaded through every periodic flow. Each sub-flow
 * picks the fields it needs (autopilot/health share `ctx + signaller`; the
 * validator additionally needs `runValidator`; reconcile only needs `ctx`).
 */
export interface TaskDaemonFlowDeps {
  readonly autopilot: AutopilotFlowDeps;
  readonly validator: ValidatorFlowDeps;
  readonly health: HealthFlowDeps;
  readonly reconcile: ReconcileFlowDeps;
}

//#endregion

//#region Working memory schema

const DaemonWorkingMemorySchema = z.object({
  recentWarnings: z.array(z.string()).default([]),
});

//#endregion

//#region Helpers

/**
 * Wrap a body step that returns a non-void payload (e.g. an autopilot report)
 * with a void-returning adapter so the daemon-fork's `paths` array stays
 * uniform at `Step<M, void, void>`. The original output is run for its
 * side-effects only.
 */
function discardOutput<O>(
  inner: Step<ContextMemory, void, O>,
  id: string,
): Step<ContextMemory, void, void> {
  return step.run<ContextMemory, void, void>({
    id,
    execute: async (_input, ctx): Promise<void> => {
      await ctx.harness.run(inner, undefined, ctx);
    },
  });
}

//#endregion

//#region Events bridge

/**
 * Build the per-tick `step.run` that tails `_events.jsonl` and forwards any
 * unseen entries onto the in-process `externalTaskEventsChan`. The watermark
 * (`sinceId`) is closed over so successive iterations only forward new rows.
 *
 * External channels are in-memory per-harness (`ChannelStore`), so cross-
 * process publishers — most importantly the agent-ci runner subprocess —
 * can't reach `getChannelHandle` directly. The append-only `_events.jsonl`
 * file is the durable transport; this bridge taps it for in-process
 * subscribers (e.g. the autopilot's reaction to runner outcomes).
 */
export function buildEventsBridgeTickStep(ctx: TaskStoreContext): Step<ContextMemory, void, void> {
  let sinceId = 0;
  return step.run<ContextMemory, void, void>({
    id: 'tasks.events-bridge.tick',
    execute: async (_input, runCtx): Promise<void> => {
      const events = await tailEvents(ctx, sinceId);
      for (const evt of events) {
        if (evt.id > sinceId) {
          sinceId = evt.id;
        }
        runCtx.send(externalTaskEventsChan, evt);
      }
    },
  });
}

//#endregion

//#region Public API

/**
 * Build the root daemon flow. The result composes four periodic `every`
 * steps (autopilot, validator, health, reconcile) plus the events bridge
 * inside a `fork({ mode: 'all' })` wrapped in a `spawn({ memory })` so the
 * memory layers (steering files, working memory) live on the daemon's
 * isolated child context.
 */
export function buildTaskDaemonFlow(deps: TaskDaemonFlowDeps): Step<ContextMemory, void, void> {
  const autopilotTick = discardOutput(
    buildAutopilotTickStep(deps.autopilot),
    'autopilot.tick.void',
  );
  const reconcileTick = discardOutput(
    buildReconcileTickStep(deps.reconcile),
    'reconcile.tick.void',
  );

  const autopilotEvery = every<ContextMemory, void, void>({
    id: 'autopilot.every',
    step: autopilotTick,
    ms: AUTOPILOT_TICK_INTERVAL_MS,
    wakeOn: featureLoopStateChan,
    onError: 'continue',
  });
  const validatorEvery = every<ContextMemory, void, void>({
    id: 'validator.every',
    step: buildValidatorIterationStep(deps.validator),
    ms: VALIDATOR_TICK_INTERVAL_MS,
    wakeOn: validatorRequestChan,
    onError: 'continue',
  });
  const healthEvery = every<ContextMemory, void, void>({
    id: 'health.every',
    step: buildHealthTickStep(deps.health),
    ms: HEALTH_TICK_INTERVAL_MS,
    onError: 'continue',
  });
  const reconcileEvery = every<ContextMemory, void, void>({
    id: 'reconcile.every',
    step: reconcileTick,
    ms: RECONCILE_TICK_INTERVAL_MS,
    onError: 'continue',
  });
  const eventsBridgeEvery = every<ContextMemory, void, void>({
    id: 'tasks.events-bridge.every',
    step: buildEventsBridgeTickStep(deps.autopilot.ctx),
    ms: EVENTS_BRIDGE_INTERVAL_MS,
    onError: 'continue',
  });

  const daemonInner = fork<ContextMemory, void, void>({
    id: 'tasks.daemon-fork',
    mode: 'all',
    paths: (): Step<ContextMemory, void, void>[] => [
      autopilotEvery,
      validatorEvery,
      healthEvery,
      reconcileEvery,
      eventsBridgeEvery,
    ],
    merge: (): void => undefined,
  });

  return spawn<ContextMemory, void, void>({
    id: 'tasks.daemon',
    child: daemonInner,
    memory: [
      createSteeringFileLayer(),
      workingMemory({
        scope: 'thread',
        schema: DaemonWorkingMemorySchema,
      }),
    ],
  });
}

//#endregion
