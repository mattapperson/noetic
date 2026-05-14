/**
 * Custom memory layer that carries the implementer's retry-feedback bundle
 * across iterations of the implementer↔validator loop.
 *
 * On a validator failure, the loop's `prepareNext` writes a feedback bundle
 * (parent-task plan + description + the validator's per-assertion failure
 * outcomes) into this layer's state via the layer's `update` function. On
 * the next iteration the implementer's react-loop `recall()` surfaces that
 * bundle as a developer-role block so the LLM sees what previous attempts
 * got wrong without sharing chat-history continuation. Each iteration is
 * therefore a "fresh context with prior verdicts attached" — the
 * "clean new context with feedback" the user spec'd.
 *
 * The layer is `'thread'`-scoped so each feature retry sequence has its
 * own state, isolated from sibling features running in parallel and from
 * the parent flow.
 */

import type { MemoryLayer } from '@noetic-tools/core';
import { layerData, layerFn, Slot } from '@noetic-tools/core';
import { z } from 'zod';
import type { AssertionOutcome } from '../hierarchy/schemas.js';
import { AssertionStatus } from '../hierarchy/schemas.js';

//#region State

const AssertionOutcomeSchema = z.object({
  assertionId: z.string(),
  status: z.enum([
    AssertionStatus.Pending,
    AssertionStatus.Passed,
    AssertionStatus.Failed,
    AssertionStatus.Blocked,
  ]),
  message: z.string().optional(),
});

const FixFeedbackUpdateSchema = z.object({
  plan: z.string().optional(),
  description: z.string().optional(),
  newIssues: z.array(AssertionOutcomeSchema).optional(),
  attempt: z.number().int().nonnegative().optional(),
});

export type FixFeedbackUpdate = z.infer<typeof FixFeedbackUpdateSchema>;

export interface FixFeedbackState {
  /** Original plan for the parent task (stable across retries). */
  readonly plan: string;
  /** Original description (stable across retries). */
  readonly description: string;
  /** Failure outcomes accumulated across all prior validator runs. */
  readonly accumulatedIssues: ReadonlyArray<AssertionOutcome>;
  /** Current attempt count (1 on the first iteration, 2 after one failure, etc.). */
  readonly attempt: number;
}

const EMPTY_STATE: FixFeedbackState = {
  plan: '',
  description: '',
  accumulatedIssues: [],
  attempt: 1,
};

//#endregion

//#region Helpers

/**
 * Format the layer state into a developer-role block.
 *
 * On the very first attempt (no prior failures) we surface only the plan +
 * description as initial context. On retries we additionally render the
 * accumulated issues so the implementer's LLM sees exactly what previous
 * attempts got wrong.
 */
export function formatFixFeedback(state: FixFeedbackState): string | null {
  const hasPlan = state.plan.length > 0;
  const hasDescription = state.description.length > 0;
  const hasIssues = state.accumulatedIssues.length > 0;
  if (!hasPlan && !hasDescription && !hasIssues) {
    return null;
  }
  const lines: string[] = [];
  lines.push('# Implementation context');
  if (state.attempt > 1) {
    lines.push(`Attempt ${state.attempt} after ${state.attempt - 1} failed validation(s).`);
  }
  if (hasPlan) {
    lines.push('', '## Plan', state.plan);
  }
  if (hasDescription) {
    lines.push('', '## Original description', state.description);
  }
  if (hasIssues) {
    lines.push('', '## Prior validation issues');
    for (const issue of state.accumulatedIssues) {
      const message = issue.message !== undefined ? `: ${issue.message}` : '';
      lines.push(`- [${issue.status}] ${issue.assertionId}${message}`);
    }
    lines.push('', 'Address each prior issue above; do not regress passing assertions.');
  }
  return lines.join('\n');
}

function mergeIssues(
  existing: ReadonlyArray<AssertionOutcome>,
  incoming: ReadonlyArray<AssertionOutcome>,
): ReadonlyArray<AssertionOutcome> {
  if (incoming.length === 0) {
    return existing;
  }
  // Latest outcome for a given assertionId wins. Keeps the layer bounded
  // even across many retries on a feature with the same assertion set.
  const byId = new Map<string, AssertionOutcome>();
  for (const issue of existing) {
    byId.set(issue.assertionId, issue);
  }
  for (const issue of incoming) {
    byId.set(issue.assertionId, issue);
  }
  return Array.from(byId.values());
}

export function applyFixFeedbackUpdate(
  state: FixFeedbackState,
  update: FixFeedbackUpdate,
): FixFeedbackState {
  return {
    plan: update.plan ?? state.plan,
    description: update.description ?? state.description,
    accumulatedIssues:
      update.newIssues !== undefined
        ? mergeIssues(state.accumulatedIssues, update.newIssues)
        : state.accumulatedIssues,
    attempt: update.attempt ?? state.attempt,
  };
}

//#endregion

//#region Public API

export const FIX_FEEDBACK_LAYER_ID = 'fix-feedback';

export interface FixFeedbackLayerOpts {
  /** Initial plan + description seeded at creation time. */
  readonly initial?: Partial<FixFeedbackState>;
}

/**
 * Build the fix-feedback memory layer used by the implementer↔validator
 * retry loop.
 */
export function createFixFeedbackLayer(
  opts: FixFeedbackLayerOpts = {},
): MemoryLayer<FixFeedbackState> {
  const initial: FixFeedbackState = {
    ...EMPTY_STATE,
    ...opts.initial,
  };

  return {
    id: FIX_FEEDBACK_LAYER_ID,
    name: 'Fix Feedback',
    slot: Slot.WORKING_MEMORY,
    scope: 'thread',
    budget: {
      min: 200,
      max: 4_000,
    },
    provides: {
      snapshot: layerData<FixFeedbackState, FixFeedbackState>({
        read: (state) => state,
      }),
      update: layerFn<FixFeedbackUpdate, void, FixFeedbackState>({
        description: 'Update the fix-feedback layer with new plan/description/issues/attempt.',
        input: FixFeedbackUpdateSchema,
        output: z.void(),
        execute: async (args, state) => ({
          result: undefined,
          state: applyFixFeedbackUpdate(state, args),
        }),
      }),
    },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<FixFeedbackState>('state');
        return {
          state: saved ?? initial,
        };
      },

      async recall({ state, ctx }) {
        const text = formatFixFeedback(state);
        if (text === null) {
          return null;
        }
        return {
          items: [
            {
              id: crypto.randomUUID(),
              status: 'completed',
              type: 'message',
              role: 'developer',
              content: [
                {
                  type: 'input_text',
                  text,
                },
              ],
            },
          ],
          tokenCount: ctx.tokenize(text),
        };
      },

      async onSpawn({ parentState }) {
        // Children inherit the parent's accumulated feedback so a
        // sub-flow (e.g. an inner react step) sees the same retry context.
        const childState: FixFeedbackState = {
          plan: parentState.plan,
          description: parentState.description,
          accumulatedIssues: [
            ...parentState.accumulatedIssues,
          ],
          attempt: parentState.attempt,
        };
        return {
          childState,
        };
      },
    },
  };
}

//#endregion
