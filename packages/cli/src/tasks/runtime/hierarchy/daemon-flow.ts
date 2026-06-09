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
 * Each sub-flow exports its own `buildXEvery` factory typed `Step<void, void>`
 * (the autopilot and reconcile factories absorb a `discardOutput` adapter
 * internally so their tick reports don't leak into the fork's path types).
 * The composition here just imports those factories — no duplicated `every({...})`
 * blocks.
 */

import { externalTaskEventsChan } from '@noetic-tools/code-agent/tasks/ipc-node';
import type { TaskStoreContext } from '@noetic-tools/code-agent/tasks/store/fs-node';
import { tailEvents } from '@noetic-tools/code-agent/tasks/store/fs-node';
import type { ContextMemory, Step } from '@noetic-tools/core';
import { every, fork, spawn, step, workingMemory } from '@noetic-tools/core';
import { z } from 'zod';
import { createSteeringFileLayer } from '../../../memory/steering-file-layer.js';
import type { AutopilotFlowDeps } from './autopilot-flow.js';
import { buildAutopilotEvery } from './autopilot-flow.js';
import type { HealthFlowDeps } from './health-flow.js';
import { buildHealthEvery } from './health-flow.js';
import type { ReconcileFlowDeps } from './reconcile-flow.js';
import { buildReconcileEvery } from './reconcile-flow.js';
import type { ValidatorFlowDeps } from './validator-flow.js';
import { buildValidatorEvery } from './validator-flow.js';

//#region Constants

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
  const autopilotEvery = buildAutopilotEvery(deps.autopilot);
  const validatorEvery = buildValidatorEvery(deps.validator);
  const healthEvery = buildHealthEvery(deps.health);
  const reconcileEvery = buildReconcileEvery(deps.reconcile);
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
