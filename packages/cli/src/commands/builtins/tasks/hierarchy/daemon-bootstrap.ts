/**
 * Daemon harness bootstrap — constructs the long-lived `AgentHarness` plus
 * the root daemon flow so `runDaemon` can drive the whole tree via
 * `harness.detachedSpawn(flow, ...)`.
 *
 * The daemon's validator now runs **agent-ci + an LLM-driven adversarial
 * code review** in parallel via {@link buildAdversarialValidatorStep}.
 * The harness is therefore configured with an LLM provider (OpenRouter
 * by default) so the adversarial path's `step.llm` can call the model.
 * When `OPENROUTER_API_KEY` is unset the harness still constructs, but
 * the adversarial path will fail-fast on the first LLM call — projects
 * that don't want adversarial review can pass `runValidator` directly
 * to short-circuit the default wiring.
 *
 * Sub-flows get:
 *
 *   - `AutopilotDeps` (FsAdapter + Signaller + planner/implementer
 *     launcher fns) so the autopilot tick can spawn plan-pass and
 *     implement-pass subprocesses.
 *   - `ValidatorJobDeps` whose `runValidator` defaults to a closure
 *     that drives `harness.run(adversarialValidatorStep, args, ctx)`.
 */

import { createCodeAgent } from '@noetic/code-agent';
import type { AgentHarness } from '@noetic/core';
import { createLocalFsAdapter, createLocalShellAdapter } from '@noetic/core';

import { defaultSignaller } from '../agent-ci-control.js';
import { externalTaskEventsChan, featureLoopStateChan, validatorRequestChan } from '../channels.js';
import { DEFAULT_MODEL } from '../defaults.js';
import type { TaskStoreContext } from '../fs-store.js';
import { startImplementerRun } from '../implementer-launcher.js';
import { startPlannerRun } from '../planner-launcher.js';
import type { AdversarialValidatorDeps } from './adversarial-validator-flow.js';
import { buildAdversarialValidatorStep } from './adversarial-validator-flow.js';
import type { AutopilotDeps, StartImplementerRunFn, StartPlannerRunFn } from './autopilot.js';
import type { TaskDaemonFlowDeps } from './daemon-flow.js';
import { buildTaskDaemonFlow } from './daemon-flow.js';
import type { ReconcileFlowDeps } from './reconcile-flow.js';
import type { RunValidatorArgs, RunValidatorFn, ValidatorJobDeps } from './validator-job.js';

//#region Types

export interface HierarchyDaemonHarnessBundle {
  readonly harness: AgentHarness;
  readonly flow: ReturnType<typeof buildTaskDaemonFlow>;
  readonly channels: {
    readonly validatorRequestChan: typeof validatorRequestChan;
    readonly featureLoopStateChan: typeof featureLoopStateChan;
    readonly externalTaskEventsChan: typeof externalTaskEventsChan;
  };
}

export interface BuildHierarchyDaemonHarnessOpts {
  /** Test seam: replace the default Step-graph validator entirely. */
  readonly runValidator?: RunValidatorFn;
  /** Override sub-deps of the default Step-graph validator (model, agent-ci, etc). */
  readonly validatorDeps?: AdversarialValidatorDeps;
  /** Test seam: override the production planner launcher. */
  readonly startPlannerRun?: StartPlannerRunFn;
  /** Test seam: override the production implementer launcher. */
  readonly startImplementerRun?: StartImplementerRunFn;
  /** OpenRouter API key. Falls back to `OPENROUTER_API_KEY`. */
  readonly apiKey?: string;
  /** Default model used by the adversarial-review LLM step. */
  readonly model?: string;
}

//#endregion

//#region Helpers

function buildDefaultRunValidator(args: {
  readonly harness: AgentHarness;
  readonly deps: AdversarialValidatorDeps;
}): RunValidatorFn {
  const flowStep = buildAdversarialValidatorStep(args.deps);
  return async (input: RunValidatorArgs) => {
    const ctx = args.harness.createContext({});
    return args.harness.run(flowStep, input, ctx);
  };
}

//#endregion

//#region Public API

export async function buildHierarchyDaemonHarness(
  projectRoot: string,
  opts: BuildHierarchyDaemonHarnessOpts = {},
): Promise<HierarchyDaemonHarnessBundle> {
  const fs = createLocalFsAdapter();
  const ctx: TaskStoreContext = {
    fs,
    projectRoot,
  };
  const autopilotDeps: AutopilotDeps = {
    ctx,
    signaller: defaultSignaller,
    startPlannerRun: opts.startPlannerRun ?? startPlannerRun,
    startImplementerRun: opts.startImplementerRun ?? startImplementerRun,
  };
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? '';
  const model = opts.model ?? process.env.NOETIC_MODEL ?? DEFAULT_MODEL;
  // The harness needs an LLM provider only because the validator's
  // adversarial-review path uses `step.llm`. Other daemon flows
  // (autopilot, health, reconcile, events-bridge) do not.
  const codeAgent = await createCodeAgent({
    name: 'noetic-tasks-daemon',
    model,
    cwd: projectRoot,
    adapters: {
      fs,
      shell: createLocalShellAdapter(),
    },
    defaultMemory: false,
    llm: {
      provider: 'openrouter',
      apiKey,
    },
  });
  const harness = codeAgent.harness;
  const validatorDeps: AdversarialValidatorDeps = {
    adversarialModel: model,
    ...opts.validatorDeps,
  };
  const validatorJobDeps: ValidatorJobDeps = {
    ctx,
    signaller: defaultSignaller,
    runValidator:
      opts.runValidator ??
      buildDefaultRunValidator({
        harness,
        deps: validatorDeps,
      }),
  };
  const reconcileDeps: ReconcileFlowDeps = {
    ctx,
  };
  const flowDeps: TaskDaemonFlowDeps = {
    autopilot: autopilotDeps,
    validator: validatorJobDeps,
    health: autopilotDeps,
    reconcile: reconcileDeps,
  };
  const flow = buildTaskDaemonFlow(flowDeps);
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
