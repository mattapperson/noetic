/**
 * Role-specific terminal tools for the planner runner.
 *
 * The planner runs as a normal turn-based chat agent (see runner-harness.ts).
 * It calls one of these terminal tools to declare it's done — either by
 * submitting a fully-formed hierarchy that gets persisted to the task tree,
 * or by abandoning planning with a reason that gets recorded as a failure.
 *
 * Each tool's `execute` fn:
 *   1. runs the same audit→state→event commit the legacy step-graph runner ran
 *   2. resolves the runner's `DetachedSignal` with the role-specific outcome,
 *      causing the runner loop to exit and the subprocess to terminate
 *
 * The schemas here mirror the historical `CompleteSchema` from `live-interview.ts`
 * exactly — same shape, same validation rules — so prompts and downstream
 * consumers don't need to learn a new envelope.
 */

import type { TaskStoreContext } from '@noetic/code-agent/tasks/store/fs-node';
import type { DetachedSignal, Tool } from '@noetic/core';
import { z } from 'zod';
import type { CommitFailureArgs, CommitSuccessArgs } from './hierarchy/planner-flow.js';
import { commitFailure, commitSuccess } from './hierarchy/planner-flow.js';
import type { TaskHierarchyInput } from './hierarchy/schemas.js';
import { createTerminalTool } from './terminal-tool.js';

//#region Outcome

export type PlannerOutcome =
  | {
      readonly status: 'completed';
      readonly hierarchy: TaskHierarchyInput;
    }
  | {
      readonly status: 'failed';
      readonly reason: string;
    };

//#endregion

//#region Schemas — mirror live-interview's CompleteSchema

const FeatureSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  acceptanceCriteria: z.string().min(1),
});

const SliceSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  verification: z.string().min(1),
  features: z.array(FeatureSchema).min(1),
});

const AssertionSchema = z.object({
  title: z.string().min(1),
  assertion: z.string().min(1),
  featureIndices: z.array(z.number().int().nonnegative()),
});

const MilestoneSchema = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  verification: z.string().min(1),
  slices: z.array(SliceSchema).min(1),
  assertions: z.array(AssertionSchema).default([]),
});

const SubmitHierarchyInputSchema = z.object({
  milestones: z.array(MilestoneSchema).min(1),
});

const SubmitHierarchyOutputSchema = z.object({
  status: z.literal('committed'),
  milestoneCount: z.number().int().nonnegative(),
});

const AbandonPlanningInputSchema = z.object({
  reason: z.string().min(1),
});

const AbandonPlanningOutputSchema = z.object({
  status: z.literal('abandoned'),
});

//#endregion

//#region Helpers

function toHierarchyInput(args: z.infer<typeof SubmitHierarchyInputSchema>): TaskHierarchyInput {
  return {
    milestones: args.milestones.map((m) => ({
      title: m.title,
      description: m.description ?? null,
      verification: m.verification,
      slices: m.slices.map((s) => ({
        title: s.title,
        description: s.description ?? null,
        verification: s.verification,
        features: s.features.map((f) => ({
          title: f.title,
          description: f.description ?? null,
          acceptanceCriteria: f.acceptanceCriteria,
        })),
      })),
      assertions: m.assertions.map((a) => ({
        title: a.title,
        assertion: a.assertion,
        featureIndices: [
          ...a.featureIndices,
        ],
      })),
    })),
  };
}

//#endregion

//#region Public API

export interface PlannerToolDeps {
  readonly storeCtx: TaskStoreContext;
  readonly taskId: string;
  readonly signal: DetachedSignal<PlannerOutcome>;
}

/**
 * Tool the planner calls when it has produced a final hierarchy. The tool
 * persists the hierarchy via the same `commitSuccess` helper the legacy
 * step-graph planner used, then resolves the runner signal so the runner
 * loop exits.
 */
export function createSubmitHierarchyTool(
  deps: PlannerToolDeps,
): Tool<typeof SubmitHierarchyInputSchema, typeof SubmitHierarchyOutputSchema> {
  return createTerminalTool<
    typeof SubmitHierarchyInputSchema,
    typeof SubmitHierarchyOutputSchema,
    PlannerOutcome
  >({
    name: 'submit_hierarchy',
    description:
      'Submit the final task hierarchy. Call this exactly once when the plan is ' +
      'complete and validated. Hierarchy must contain at least one milestone, each ' +
      'with at least one slice containing at least one feature.',
    input: SubmitHierarchyInputSchema,
    output: SubmitHierarchyOutputSchema,
    signal: deps.signal,
    commit: async (args) => {
      const hierarchy = toHierarchyInput(args);
      const commitArgs: CommitSuccessArgs = {
        storeCtx: deps.storeCtx,
        taskId: deps.taskId,
        hierarchy,
      };
      await commitSuccess(commitArgs);
      const outcome: PlannerOutcome = {
        status: 'completed',
        hierarchy,
      };
      return {
        outcome,
        output: {
          status: 'committed',
          milestoneCount: hierarchy.milestones.length,
        },
      };
    },
  });
}

/**
 * Tool the planner calls when it cannot produce a hierarchy (e.g. the user
 * declined to provide enough context, or the task description is too thin).
 * Records a failure via `commitFailure` and resolves the runner signal.
 */
export function createAbandonPlanningTool(
  deps: PlannerToolDeps,
): Tool<typeof AbandonPlanningInputSchema, typeof AbandonPlanningOutputSchema> {
  return createTerminalTool<
    typeof AbandonPlanningInputSchema,
    typeof AbandonPlanningOutputSchema,
    PlannerOutcome
  >({
    name: 'abandon_planning',
    description:
      'Abandon planning. Call this when you cannot produce a meaningful hierarchy ' +
      '(missing context, scope unclear, user declines to clarify, etc.). The reason ' +
      'is recorded as the planner failure message.',
    input: AbandonPlanningInputSchema,
    output: AbandonPlanningOutputSchema,
    signal: deps.signal,
    commit: async (args) => {
      const failureArgs: CommitFailureArgs = {
        storeCtx: deps.storeCtx,
        taskId: deps.taskId,
        reason: args.reason,
        status: 'failed',
      };
      await commitFailure(failureArgs);
      const outcome: PlannerOutcome = {
        status: 'failed',
        reason: args.reason,
      };
      return {
        outcome,
        output: {
          status: 'abandoned',
        },
      };
    },
  });
}

//#endregion
