/**
 * Step-graph planner flow.
 *
 * The planner runs as its own subprocess (spawned by `planner-launcher.ts`).
 * Inside the subprocess, the work it does is now expressed as a Noetic
 * Step graph rather than imperative TypeScript:
 *
 *   branch({
 *     id: 'planner.gate',
 *     route: async (input, ctx) => {
 *       await ctx.memory['planner-attempts'].recordAttempt({taskId});
 *       const exists = await hasHierarchy(...);
 *       return exists ? alreadyPlannedStep : interviewAndCommitStep;
 *     },
 *   });
 *
 * The route function performs two side effects atomically: bumping the
 * planner-attempt counter (so the autopilot can budget retries) and
 * choosing the body step. The body steps own their own commit (audit →
 * state → event), keeping the imperative I/O sequenced inside one
 * `step.run.execute`.
 *
 * The runner wires this with the steering-file layer plus the
 * planner-attempt layer so the body steps see steering content via
 * `recall()` and the gate sees the budget via `ctx.memory`.
 */

import type { Context, ContextMemory, MemoryLayer, Step } from '@noetic/core';
import { branch, interview, step } from '@noetic/core';

import { createSteeringFileLayer } from '../../../../memory/steering-file-layer.js';
import type { TaskStoreContext } from '../fs-store.js';
import { appendEvent, appendLog, hasHierarchy, loadTask, saveTask } from '../fs-store.js';
import { createLlmInterviewResponder } from '../llm-interview-responder.js';
import {
  createPlannerAttemptLayer,
  PLANNER_ATTEMPT_LAYER_ID,
} from '../memory/planner-attempt-layer.js';
import { clearPlanner } from '../planner-state.js';
import type { Task } from '../schemas.js';
import { AutopilotState, EventKind, HierarchyStatus, LogEntryKind } from '../schemas.js';
import type { InterviewComplete, InterviewQuestion } from './live-interview.js';
import { CompleteSchema, QuestionSchema, toTaskHierarchyInput } from './live-interview.js';
import { persistTaskHierarchy } from './persist.js';
import { INTERVIEW_SYSTEM_PROMPT } from './prompts.js';
import type { TaskHierarchyInput } from './schemas.js';

//#region Types

export type PlannerOutcome =
  | {
      readonly status: 'completed';
      readonly hierarchy: TaskHierarchyInput;
    }
  | {
      readonly status: 'maxQuestions';
      readonly reason: string;
    }
  | {
      readonly status: 'failed';
      readonly reason: string;
    };

export interface PlannerFlowInput {
  readonly taskId: string;
  readonly task: Task;
  readonly description: string;
}

/** Replaceable interview executor so tests can short-circuit the LLM. */
export type RunInterviewFn = (args: {
  readonly ctx: Context<ContextMemory>;
  readonly model: string;
  readonly task: Task;
  readonly description: string;
  readonly maxQuestions?: number;
}) => Promise<PlannerOutcome>;

export interface PlannerFlowDeps {
  /** Backing FS context for audit / state / event writes. */
  readonly storeCtx: TaskStoreContext;
  readonly model: string;
  /** Test seam: replace the interview() driver. */
  readonly runInterview?: RunInterviewFn;
  readonly maxQuestions?: number;
}

//#endregion

//#region Helpers

function nowIso(): string {
  return new Date().toISOString();
}

interface CommitSuccessArgs {
  readonly storeCtx: TaskStoreContext;
  readonly taskId: string;
  readonly hierarchy: TaskHierarchyInput;
}

async function commitSuccess(args: CommitSuccessArgs): Promise<void> {
  const ts = nowIso();
  await appendLog(args.storeCtx, {
    taskId: args.taskId,
    entry: {
      kind: LogEntryKind.System,
      ts,
      message: `planner completed: ${args.hierarchy.milestones.length} milestone(s) persisted`,
    },
  });
  await persistTaskHierarchy(args.storeCtx, args.taskId, args.hierarchy);
  const task = await loadTask(args.storeCtx, args.taskId);
  const next: Task = {
    ...task,
    hierarchyStatus: HierarchyStatus.Active,
    autopilotState: AutopilotState.Watching,
    lastAutopilotActivityAt: ts,
    updatedAt: ts,
    lastSeenAt: ts,
  };
  await saveTask(args.storeCtx, next);
  await appendEvent(args.storeCtx, {
    taskId: args.taskId,
    kind: EventKind.HierarchyStatusChanged,
    payload: {
      hierarchyStatus: HierarchyStatus.Active,
      milestoneCount: args.hierarchy.milestones.length,
    },
    ts,
  });
  await clearPlanner(args.storeCtx, args.taskId).catch(() => {
    /* swallow — sidecar will be evicted by the next launcher's pid check */
  });
}

interface CommitFailureArgs {
  readonly storeCtx: TaskStoreContext;
  readonly taskId: string;
  readonly reason: string;
  readonly status: 'failed' | 'maxQuestions';
}

async function commitFailure(args: CommitFailureArgs): Promise<void> {
  const ts = nowIso();
  await appendLog(args.storeCtx, {
    taskId: args.taskId,
    entry: {
      kind: LogEntryKind.System,
      ts,
      message: `planner ${args.status}: ${args.reason}`,
    },
  });
  const task = await loadTask(args.storeCtx, args.taskId);
  const next: Task = {
    ...task,
    autopilotState: AutopilotState.Inactive,
    lastAutopilotActivityAt: ts,
    updatedAt: ts,
    lastSeenAt: ts,
  };
  await saveTask(args.storeCtx, next);
  await appendEvent(args.storeCtx, {
    taskId: args.taskId,
    kind: EventKind.TaskUpdated,
    payload: {
      autopilotState: AutopilotState.Inactive,
      plannerStatus: args.status,
      reason: args.reason,
      phase: 'exit',
    },
    ts,
  });
  await clearPlanner(args.storeCtx, args.taskId).catch(() => {
    /* swallow */
  });
}

//#endregion

//#region Default interview executor

const defaultRunInterview: RunInterviewFn = async (args) => {
  const askQuestion = createLlmInterviewResponder({
    ctx: args.ctx,
    model: args.model,
    taskTitle: args.task.title,
    taskDescription: args.description,
  });
  let captured: InterviewComplete | null = null;
  const interviewStep = interview<InterviewQuestion, InterviewComplete>({
    systemPrompt: INTERVIEW_SYSTEM_PROMPT,
    model: args.model,
    questionSchema: QuestionSchema,
    completeSchema: CompleteSchema,
    askQuestion,
    onComplete: async (envelope) => {
      captured = envelope;
    },
    maxQuestions: args.maxQuestions,
  });
  const initial = `Plan a hierarchy for the task titled: ${args.task.title}.`;
  try {
    const result = await args.ctx.harness.run(interviewStep, initial, args.ctx);
    if (result.status === 'maxQuestions') {
      return {
        status: 'maxQuestions',
        reason: 'interview exceeded the question budget without completing',
      };
    }
    if (captured === null) {
      return {
        status: 'failed',
        reason: 'interview reported complete but onComplete never fired',
      };
    }
    return {
      status: 'completed',
      hierarchy: toTaskHierarchyInput(captured),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 'failed',
      reason: message,
    };
  }
};

//#endregion

//#region Step graph

interface PlannerFlowSteps {
  readonly alreadyPlannedStep: Step<ContextMemory, PlannerFlowInput, PlannerOutcome>;
  readonly interviewAndCommitStep: Step<ContextMemory, PlannerFlowInput, PlannerOutcome>;
}

function buildPlannerFlowSteps(deps: PlannerFlowDeps): PlannerFlowSteps {
  const runInterview = deps.runInterview ?? defaultRunInterview;
  const alreadyPlannedStep = step.run<ContextMemory, PlannerFlowInput, PlannerOutcome>({
    id: 'planner.already-planned',
    execute: async (input) => {
      const reason = 'task already has a hierarchy';
      await commitFailure({
        storeCtx: deps.storeCtx,
        taskId: input.taskId,
        reason,
        status: 'failed',
      });
      return {
        status: 'failed',
        reason,
      };
    },
  });

  const interviewAndCommitStep = step.run<ContextMemory, PlannerFlowInput, PlannerOutcome>({
    id: 'planner.interview-and-commit',
    execute: async (input, ctx) => {
      const outcome = await runInterview({
        ctx,
        model: deps.model,
        task: input.task,
        description: input.description,
        maxQuestions: deps.maxQuestions,
      });
      if (outcome.status === 'completed') {
        await commitSuccess({
          storeCtx: deps.storeCtx,
          taskId: input.taskId,
          hierarchy: outcome.hierarchy,
        });
      } else {
        await commitFailure({
          storeCtx: deps.storeCtx,
          taskId: input.taskId,
          reason: outcome.reason,
          status: outcome.status,
        });
      }
      return outcome;
    },
  });

  return {
    alreadyPlannedStep,
    interviewAndCommitStep,
  };
}

//#endregion

//#region Public API

export interface BuildPlannerFlowResult {
  readonly step: Step<ContextMemory, PlannerFlowInput, PlannerOutcome>;
  /** Memory layers the runner must mount on the harness/context. */
  readonly layers: ReadonlyArray<MemoryLayer>;
}

/**
 * Build the planner flow as a Step graph rooted at a `branch` whose
 * route function increments the planner-attempt counter and picks
 * `alreadyPlanned` vs `interviewAndCommit` based on whether the task
 * already carries a `hierarchy/` subdirectory.
 */
export function buildPlannerFlow(deps: PlannerFlowDeps): BuildPlannerFlowResult {
  const { alreadyPlannedStep, interviewAndCommitStep } = buildPlannerFlowSteps(deps);
  const plannerAttemptLayer = createPlannerAttemptLayer({
    projectRoot: deps.storeCtx.projectRoot,
  });
  const steeringLayer = createSteeringFileLayer();

  const flowStep = branch<ContextMemory, PlannerFlowInput, PlannerOutcome>({
    id: 'planner.gate',
    route: async (input, ctx) => {
      // Bump the per-task attempt counter so the autopilot's plan-pass
      // budget gate sees the new count on its next tick. Even on
      // already-planned task this records the spawn (so a misfiring
      // launcher still gets caught by the budget cap).
      const attempts = ctx.memory[PLANNER_ATTEMPT_LAYER_ID];
      if (attempts === undefined) {
        // Hard-fail rather than silently no-op: a missing layer would
        // unbound the per-task spawn budget, which is the bug this gate
        // was added to prevent.
        throw new Error(
          'planner-attempts memory layer is not mounted on the harness; ' +
            'wire it via flow.layers from buildPlannerFlow().',
        );
      }
      const recordAttempt = attempts.recordAttempt;
      if (typeof recordAttempt !== 'function') {
        throw new Error(
          'planner-attempts.recordAttempt is not callable; mounted layer is malformed.',
        );
      }
      await recordAttempt({
        taskId: input.taskId,
      });
      const exists = await hasHierarchy(deps.storeCtx, input.taskId);
      return exists ? alreadyPlannedStep : interviewAndCommitStep;
    },
  });

  return {
    step: flowStep,
    layers: [
      plannerAttemptLayer,
      steeringLayer,
    ],
  };
}

//#endregion
