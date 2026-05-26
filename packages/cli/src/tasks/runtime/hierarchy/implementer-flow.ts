/**
 * Implementer-flow helpers consumed by the chat-based implementer runner.
 *
 * The legacy step-graph implementer (`buildImplementerFlow` + react-loop
 * step) is gone — the runner now uses turn-based chat (see
 * ../implementer-runner.ts) with `signal_implementation_done` /
 * `signal_implementation_blocked` tools. The helpers below survived the
 * refactor: they seed the fix-feedback memory layer from a feature's
 * fix lineage so a re-attempt sees what previous attempts got wrong.
 */

import type { AssertionOutcome } from '@noetic/code-agent/tasks/schema';
import { AssertionStatus } from '@noetic/code-agent/tasks/schema';
import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import type { FixFeedbackState } from '../memory/fix-feedback-layer.js';
import { readFixLineage } from './fix-feature.js';
import { loadValidatorRun } from './validator.js';

//#region Outcome shape

/** @public Outcome reported by the implementer runner's terminal tools. */
export interface ImplementerOutcome {
  readonly status: 'completed' | 'blocked';
  readonly summary: string;
  readonly blockedReason?: string;
}

//#endregion

//#region Fix-feedback seeding helpers

/**
 * Read the accumulated assertion failures from this feature's fix lineage.
 * Runs every validator-run lookup in parallel so a long lineage doesn't
 * add per-row latency to implementer startup.
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
