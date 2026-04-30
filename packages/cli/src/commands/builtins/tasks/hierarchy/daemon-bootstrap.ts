/**
 * Daemon harness bootstrap — constructs the long-lived `AgentHarness` plus
 * the root daemon flow so `runDaemon` can drive the whole tree via
 * `harness.detachedSpawn(flow, ...)`.
 *
 * The daemon doesn't exercise `step.llm` (no LLM calls in autopilot/health/
 * reconcile/events-bridge bodies), so the harness is constructed minimally —
 * no plugins, no skills, no tools, no LLM client. Sub-flows get a thin
 * `AutopilotDeps`-shaped bag (FsAdapter + Signaller) plus a `runValidator`
 * stub for the validator flow; the validator's external-subprocess path is
 * wired via {@link validatorLauncherTool} downstream.
 */

import { AgentHarness, createLocalFsAdapter } from '@noetic/core';

import { defaultSignaller } from '../agent-ci-control.js';
import { externalTaskEventsChan, featureLoopStateChan, validatorRequestChan } from '../channels.js';
import type { TaskStoreContext } from '../fs-store.js';
import type { AutopilotDeps } from './autopilot.js';
import type { TaskDaemonFlowDeps } from './daemon-flow.js';
import { buildTaskDaemonFlow } from './daemon-flow.js';
import type { ReconcileFlowDeps } from './reconcile-flow.js';
import type { RunValidatorArgs, ValidatorJobDeps, ValidatorRunOutcome } from './validator-job.js';

//#region Types

/**
 * Bundle returned by {@link buildHierarchyDaemonHarness} — the harness, the
 * composed root flow, and the inter-step channels exposed for tests and
 * out-of-process publishers to address.
 */
export interface HierarchyDaemonHarnessBundle {
  readonly harness: AgentHarness;
  readonly flow: ReturnType<typeof buildTaskDaemonFlow>;
  readonly channels: {
    readonly validatorRequestChan: typeof validatorRequestChan;
    readonly featureLoopStateChan: typeof featureLoopStateChan;
    readonly externalTaskEventsChan: typeof externalTaskEventsChan;
  };
}

//#endregion

//#region Helpers

/**
 * Default `runValidator` for the daemon-mode validator flow. The production
 * wiring will swap this for a {@link validatorLauncherTool}-driven function
 * that spawns the external validator subprocess; the stub here returns an
 * `error` outcome so the validator flow's record-run lifecycle still observes
 * a terminal status when no runner is configured.
 */
async function noRunnerConfigured(_args: RunValidatorArgs): Promise<ValidatorRunOutcome> {
  return {
    status: 'error',
    summary: 'No validator runner is configured for the daemon harness.',
  };
}

//#endregion

//#region Public API

/**
 * Construct the daemon-mode `AgentHarness`, the composed root flow, and the
 * channel-handle triple that out-of-process callers can address.
 *
 * The daemon harness is intentionally lean — no skills, plugins, tools, or
 * LLM client. It exists only to host the Step graph (memory layers, channel
 * store, trace exporter, abort signalling) for the periodic flows.
 */
export function buildHierarchyDaemonHarness(projectRoot: string): HierarchyDaemonHarnessBundle {
  const fs = createLocalFsAdapter();
  const ctx: TaskStoreContext = {
    fs,
    projectRoot,
  };
  const autopilotDeps: AutopilotDeps = {
    ctx,
    signaller: defaultSignaller,
  };
  const validatorDeps: ValidatorJobDeps = {
    ctx,
    signaller: defaultSignaller,
    runValidator: noRunnerConfigured,
  };
  const reconcileDeps: ReconcileFlowDeps = {
    ctx,
  };
  const flowDeps: TaskDaemonFlowDeps = {
    autopilot: autopilotDeps,
    validator: validatorDeps,
    health: autopilotDeps,
    reconcile: reconcileDeps,
  };
  const flow = buildTaskDaemonFlow(flowDeps);
  const harness = new AgentHarness({
    name: 'noetic-tasks-daemon',
    params: {},
    fs,
    initialCwd: projectRoot,
  });
  return {
    harness,
    flow,
    channels: {
      validatorRequestChan,
      featureLoopStateChan,
      externalTaskEventsChan,
    },
  };
}

//#endregion
