/**
 * Step-graph implementer flow.
 *
 * Wraps the implementer's `react()` execution as a Noetic Step graph
 * with two memory layers mounted:
 *
 *   - `steering-file` — surfaces `<taskDir>/steering.md` to the agent.
 *   - `fix-feedback`  — surfaces accumulated prior validation failures
 *     across the feature's fix lineage so the next attempt's LLM sees
 *     "what previous attempts got wrong" without needing chat-history
 *     continuation.
 *
 * The retry loop itself spans **multiple subprocess invocations** —
 * each implementer subprocess is one attempt; failures generate a
 * fresh fix-feature via `fix-feature.ts`; the autopilot's implement-pass
 * then spawns another implementer for the new feature. This module
 * therefore handles **one attempt** and surfaces prior context, but
 * doesn't itself loop — that is the daemon's job.
 */

import type { Context, ContextMemory, MemoryLayer, Step, Tool } from '@noetic/core';
import { step } from '@noetic/core';

import { createSteeringFileLayer } from '../../../../memory/steering-file-layer.js';
import type { TaskStoreContext } from '../fs-store.js';
import type { FixFeedbackState } from '../memory/fix-feedback-layer.js';
import { createFixFeedbackLayer } from '../memory/fix-feedback-layer.js';
import { readFixLineage } from './fix-feature.js';
import type { Assertion, AssertionOutcome, Feature } from './schemas.js';
import { AssertionStatus } from './schemas.js';
import { loadValidatorRun } from './validator.js';

//#region Types

export interface ImplementerOutcome {
  readonly status: 'completed' | 'blocked';
  readonly summary: string;
  readonly blockedReason?: string;
}

export type RunReactFn = (args: {
  readonly ctx: Context<ContextMemory>;
  readonly tools: ReadonlyArray<Tool>;
  readonly model: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly maxSteps: number;
}) => Promise<ImplementerOutcome>;

export interface ImplementerFlowInput {
  readonly feature: Feature;
  readonly assertions: ReadonlyArray<Assertion>;
  readonly worktreeCwd: string;
  /** Concrete prompt the implementer's react loop runs against. */
  readonly prompt: string;
  /** Coding tools mounted on the harness for this run. */
  readonly tools: ReadonlyArray<Tool>;
}

export interface ImplementerFlowDeps {
  readonly model: string;
  readonly maxSteps: number;
  /** Test seam: replace the react() executor. */
  readonly runReact?: RunReactFn;
  /** Pre-computed initial state for the fix-feedback layer. */
  readonly fixFeedbackInitial?: Partial<FixFeedbackState>;
}

//#endregion

//#region Default react executor

const defaultRunReact: RunReactFn = async (args) => {
  const { react } = await import('@noetic/core');
  const reactStep = react({
    model: args.model,
    tools: [
      ...args.tools,
    ],
    maxSteps: args.maxSteps,
  });
  // Use a child context rooted at the worktree so tool cwds resolve
  // correctly. The child inherits the parent's memory layers (including
  // fix-feedback), so the LLM sees prior issues via `recall()` on its
  // first turn.
  const ctx = args.ctx.harness.createContext({
    cwdInit: args.cwd,
    parent: args.ctx,
  });
  try {
    const summary = await args.ctx.harness.run(reactStep, args.prompt, ctx);
    return {
      status: 'completed',
      summary,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'blocked',
      summary: message,
      blockedReason: message,
    };
  }
};

//#endregion

//#region Public API

export interface BuildImplementerFlowResult {
  readonly step: Step<ContextMemory, ImplementerFlowInput, ImplementerOutcome>;
  /** Memory layers the runner must mount on the harness/context. */
  readonly layers: ReadonlyArray<MemoryLayer>;
}

/**
 * Build the implementer flow: a single-iteration `step.run` wrapping
 * the react() call, with the fix-feedback + steering layers attached.
 *
 * Multi-attempt retry is owned by the daemon (autopilot's implement-pass
 * re-spawns an implementer subprocess for each fix-feature). This module
 * surfaces prior-attempt context to the LLM via the fix-feedback layer.
 */
export function buildImplementerFlow(deps: ImplementerFlowDeps): BuildImplementerFlowResult {
  const runReact = deps.runReact ?? defaultRunReact;
  const fixFeedbackLayer = createFixFeedbackLayer({
    initial: deps.fixFeedbackInitial,
  });
  const steeringLayer = createSteeringFileLayer();

  const flowStep = step.run<ContextMemory, ImplementerFlowInput, ImplementerOutcome>({
    id: 'implementer.flow',
    execute: async (input, ctx) => {
      return runReact({
        ctx,
        tools: input.tools,
        model: deps.model,
        prompt: input.prompt,
        cwd: input.worktreeCwd,
        maxSteps: deps.maxSteps,
      });
    },
  });

  return {
    step: flowStep,
    layers: [
      fixFeedbackLayer,
      steeringLayer,
    ],
  };
}

//#endregion

//#region Fix-feedback seeding helpers

/**
 * Read the accumulated assertion failures from this feature's fix lineage.
 * Runs every validator-run lookup in parallel so a long lineage doesn't
 * add per-row latency to implementer startup.
 *
 * Independent of plan/description text, so callers can run this in
 * parallel with other disk reads (the runner does this with
 * `loadParentDescription`).
 */
export async function loadAccumulatedIssues(args: {
  readonly storeCtx: TaskStoreContext;
  readonly parentTaskId: string;
  readonly featureId: string;
}): Promise<AssertionOutcome[]> {
  const taskCtx = {
    ...args.storeCtx,
    taskId: args.parentTaskId,
  };
  const lineage = await readFixLineage(taskCtx, args.featureId);
  const runs = await Promise.all(
    lineage.map((row) => loadValidatorRun(taskCtx, row.sourceFeatureId, row.validatorRunId)),
  );
  const accumulatedIssues: AssertionOutcome[] = [];
  for (const run of runs) {
    if (run === null) {
      continue;
    }
    for (const outcome of run.assertionOutcomes) {
      if (outcome.status === AssertionStatus.Failed) {
        accumulatedIssues.push(outcome);
      }
    }
  }
  return accumulatedIssues;
}

/**
 * Assemble the fix-feedback layer's initial state from independently-loaded
 * pieces. Pure — callers fetch the inputs in parallel and pass them in.
 */
export function buildFixFeedbackSeed(args: {
  readonly plan: string;
  readonly description: string;
  readonly accumulatedIssues: ReadonlyArray<AssertionOutcome>;
  readonly attempt: number;
}): Partial<FixFeedbackState> {
  return {
    plan: args.plan,
    description: args.description,
    accumulatedIssues: [
      ...args.accumulatedIssues,
    ],
    attempt: args.attempt,
  };
}

//#endregion
