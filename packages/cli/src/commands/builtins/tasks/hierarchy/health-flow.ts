/**
 * Health flow — periodically reaps stale validator runs (pid no longer alive
 * or start-time changed) and reconciles feature ↔ leaf-task drift (in-flight
 * features whose linked task was deleted out from under them get marked
 * blocked).
 *
 * Composed as `every({ step: healthTickStep, ms: 300_000 })` so the daemon
 * orchestrator can drop it into a `fork({ mode: 'all', paths: [...] })`
 * alongside the autopilot, validator, and reconcile flows. The whole tree is
 * driven by `harness.detachedSpawn(...)` from the daemon entry.
 */

import type { ContextMemory, Step, StepEvery } from '@noetic/core';
import { every, step } from '@noetic/core';

import type { HealthJobDeps } from './health-job.js';
import { runHealthTick } from './health-job.js';

//#region Constants

const HEALTH_TICK_INTERVAL_MS = 5 * 60_000;

//#endregion

//#region Types

/** Long-lived dependencies passed to the health flow. */
export type HealthFlowDeps = HealthJobDeps;

//#endregion

//#region Steps

/**
 * Build the per-tick `step.run` that drives one health pass. Captured in a
 * factory so the deps are bound when the flow is constructed; the resulting
 * step takes `void` input.
 */
export function buildHealthTickStep(deps: HealthFlowDeps): Step<ContextMemory, void, void> {
  return step.run<ContextMemory, void, void>({
    id: 'health.tick',
    execute: async (): Promise<void> => {
      await runHealthTick(deps);
    },
  });
}

//#endregion

//#region Public API

/**
 * Build the health `every` for the daemon flow. The body runs every
 * `300_000` ms (5 min); `onError: 'continue'` keeps the daemon up across
 * transient FS failures (the next tick reconciles whatever was missed).
 */
export function buildHealthEvery(deps: HealthFlowDeps): StepEvery<ContextMemory, void, void> {
  return every<ContextMemory, void, void>({
    id: 'health.every',
    step: buildHealthTickStep(deps),
    ms: HEALTH_TICK_INTERVAL_MS,
    onError: 'continue',
  });
}

//#endregion
