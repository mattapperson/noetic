/**
 * Role-specific terminal tools for the implementer runner.
 *
 * The implementer runs as a normal turn-based chat agent (see
 * runner-harness.ts) with the standard coding tools. It calls one of these
 * terminal tools to declare it's done — either by signalling that the
 * feature is implemented (parent feature transitions to Validating) or
 * blocked (parent feature transitions to Blocked with a reason).
 *
 * The actual audit→state→event commit lives in `implementer-runner.ts`
 * as `commitExitWrites`; these tools just shape the outcome and resolve
 * the runner signal so the runner loop exits.
 */

import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import type { DetachedSignal, Tool } from '@noetic/core';
import { z } from 'zod';
import type { ImplementerOutcome } from './hierarchy/implementer-flow.js';
import { commitExitWrites } from './implementer-commit.js';
import { createTerminalTool } from './terminal-tool.js';

//#region Schemas

const ImplementationDoneInputSchema = z.object({
  summary: z.string().min(1),
});

const ImplementationDoneOutputSchema = z.object({
  status: z.literal('completed'),
});

const ImplementationBlockedInputSchema = z.object({
  reason: z.string().min(1),
});

const ImplementationBlockedOutputSchema = z.object({
  status: z.literal('blocked'),
});

//#endregion

//#region Public API

export interface ImplementerToolDeps {
  readonly storeCtx: TaskStoreContext;
  readonly leafTaskId: string;
  readonly parentTaskId: string;
  readonly featureId: string;
  readonly signal: DetachedSignal<ImplementerOutcome>;
}

/**
 * Tool the implementer calls when the feature is implemented and ready
 * for validation. The tool runs `commitExitWrites` with status='completed'
 * (parent feature → Validating) and resolves the signal.
 */
export function createImplementationDoneTool(
  deps: ImplementerToolDeps,
): Tool<typeof ImplementationDoneInputSchema, typeof ImplementationDoneOutputSchema> {
  return createTerminalTool<
    typeof ImplementationDoneInputSchema,
    typeof ImplementationDoneOutputSchema,
    ImplementerOutcome
  >({
    name: 'signal_implementation_done',
    description:
      'Signal that the feature is implemented and the work should be handed off ' +
      'to the validator. Provide a one-paragraph summary of what was changed and ' +
      'why. Call this exactly once when the acceptance criteria are met.',
    input: ImplementationDoneInputSchema,
    output: ImplementationDoneOutputSchema,
    signal: deps.signal,
    commit: async (args) => {
      const outcome: ImplementerOutcome = {
        status: 'completed',
        summary: args.summary,
      };
      await commitExitWrites({
        ctx: deps.storeCtx,
        leafTaskId: deps.leafTaskId,
        parentTaskId: deps.parentTaskId,
        featureId: deps.featureId,
        outcome,
      });
      return {
        outcome,
        output: {
          status: 'completed',
        },
      };
    },
  });
}

/**
 * Tool the implementer calls when it cannot complete the feature. Records
 * the parent feature as Blocked with the given reason and resolves the
 * runner signal so the runner exits with a non-zero status.
 */
export function createImplementationBlockedTool(
  deps: ImplementerToolDeps,
): Tool<typeof ImplementationBlockedInputSchema, typeof ImplementationBlockedOutputSchema> {
  return createTerminalTool<
    typeof ImplementationBlockedInputSchema,
    typeof ImplementationBlockedOutputSchema,
    ImplementerOutcome
  >({
    name: 'signal_implementation_blocked',
    description:
      'Signal that the feature cannot be implemented in this attempt. Provide ' +
      'a single-sentence reason describing what blocks progress (missing context, ' +
      'unresolvable test failure, etc.). The parent feature is marked Blocked.',
    input: ImplementationBlockedInputSchema,
    output: ImplementationBlockedOutputSchema,
    signal: deps.signal,
    commit: async (args) => {
      const outcome: ImplementerOutcome = {
        status: 'blocked',
        summary: args.reason,
        blockedReason: args.reason,
      };
      await commitExitWrites({
        ctx: deps.storeCtx,
        leafTaskId: deps.leafTaskId,
        parentTaskId: deps.parentTaskId,
        featureId: deps.featureId,
        outcome,
      });
      return {
        outcome,
        output: {
          status: 'blocked',
        },
      };
    },
  });
}

//#endregion
