/**
 * Plan agent — the top-level read-only planning sub-agent.
 *
 * The plan agent is the default entry route. It uses read-only tools and
 * sub-agent orchestration to produce a plan; when ready, it calls
 * `requestPlanApproval`. The outer workflow branches to the approval
 * sequence (or auto-approval if no AskUserQuestion service is registered),
 * flips flow-state `mode` to `act`, and the next user turn routes to the
 * act sub-agent.
 */

import type { AskUserInput, AskUserOutput, Context, ContextMemory, Step, Tool } from '@noetic/core';
import { AskUserOutputSchema, branch, loop, spawn, step, tool, until } from '@noetic/core/portable';
import { frameworkCast } from '@noetic/core/unstable';
import { z } from 'zod';
import type { CodeAgentFlowState } from './flow-state.js';
import {
  CODE_AGENT_FLOW_LAYER_ID,
  persistFlowState,
  readFlowState,
  writeFlowState,
} from './flow-state.js';
import {
  filterToolsByNames,
  getAskUserTool,
  hasAskUserQuestion,
  isString,
  readParam,
  readUnifiedTools,
} from './shared.js';

//#region Constants

/**
 * Tool names the plan agent is permitted to call. Restricted to read-only
 * exploration, user interaction, sub-agent orchestration, and the approval
 * tool. Excludes Write / Edit / Bash and anything else that mutates the
 * filesystem or shell state before the plan is approved.
 */
export const PLAN_MODE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Find',
  'Ls',
  'AskUserQuestion',
  'activateSkill',
  'agent',
  'sendMessage',
  'checkAgent',
]);

/** Label prefix used for the approve option; matched case-insensitively. */
const APPROVE_OPTION_LABEL = 'Approve (Recommended)';
const REVISE_OPTION_LABEL = 'Revise';

/** Hard ceiling on approval-question length so the tool args survive validation. */
const DEFAULT_APPROVAL_QUESTION = 'Approve this plan and switch to act mode?';
const DEFAULT_APPROVAL_HEADER = 'Approve';

const PLAN_SYSTEM_INSTRUCTIONS =
  'You are the top-level plan agent. Stay in plan mode until the user approves the plan. Use read-only tools, AskUserQuestion for requirement choices, and sub-agents for bounded exploration or planning work. When the plan is ready, call requestPlanApproval; the workflow will ask the user and switch to act mode only after approval.';

const RequestPlanApprovalInputSchema = z.object({
  question: z.string().min(1).default(DEFAULT_APPROVAL_QUESTION),
  header: z.string().min(1).max(12).default(DEFAULT_APPROVAL_HEADER),
});

const RequestPlanApprovalOutputSchema = z.object({
  awaitingApproval: z.boolean(),
  question: z.string(),
});

//#endregion

//#region Helpers

function answerLooksApproved(value: string): boolean {
  return value.toLowerCase().startsWith('approve');
}

/**
 * Builds the AskUserQuestion tool input for the plan-approval prompt. Sourced
 * from the flow state so the question text matches exactly what the LLM
 * requested via `requestPlanApproval`.
 */
function buildApprovalAskInput(state: CodeAgentFlowState, previousPlanText: string): AskUserInput {
  const question = state.approvalQuestion?.question ?? DEFAULT_APPROVAL_QUESTION;
  const header = state.approvalQuestion?.header ?? DEFAULT_APPROVAL_HEADER;
  const trimmed = previousPlanText.trim();
  const preview = trimmed.length > 0 ? trimmed : undefined;
  return {
    questions: [
      {
        question,
        header,
        options: [
          {
            label: APPROVE_OPTION_LABEL,
            description:
              'The workflow records act mode and the act agent can start implementation.',
            ...(preview
              ? {
                  preview,
                }
              : {}),
          },
          {
            label: REVISE_OPTION_LABEL,
            description:
              'The workflow stays in plan mode so the plan agent can revise the approach.',
          },
        ],
        multiSelect: false,
      },
    ],
  };
}

/**
 * Extracts the first (and, by construction, only) answer from the AskUser
 * output. Looking up by position avoids coupling the approval record to the
 * exact question text — `buildApprovalAskInput` emits one question, so
 * `answers` has exactly one entry.
 */
function extractApprovalAnswer(output: AskUserOutput): string {
  const first = Object.values(output.answers)[0];
  return typeof first === 'string' ? first : '';
}

//#endregion

//#region Tool — requestPlanApproval

/**
 * Tool via which the plan-mode LLM signals that it wants user approval. The
 * tool mutates memory through the typed `toolCtx.memory.set` helper (the
 * `ToolMemory` API from `@noetic/core`) rather than reaching into
 * `ctx.harness.setLayerState` through a cast.
 */
export const requestPlanApproval: Tool = tool({
  name: 'requestPlanApproval',
  description:
    'Request user approval for the current implementation plan. This marks the workflow as awaiting approval; the workflow asks the user and switches to act mode only after approval.',
  input: RequestPlanApprovalInputSchema,
  output: RequestPlanApprovalOutputSchema,
  async execute(input, toolCtx) {
    const existing = toolCtx.memory.get<CodeAgentFlowState>(CODE_AGENT_FLOW_LAYER_ID) ?? {};
    toolCtx.memory.set<CodeAgentFlowState>(CODE_AGENT_FLOW_LAYER_ID, {
      ...existing,
      mode: 'plan',
      awaitingPlanApproval: true,
      approvalQuestion: {
        question: input.question,
        header: input.header,
      },
    });
    return {
      awaitingApproval: true,
      question: input.question,
    };
  },
});

//#endregion

//#region Approval sequence steps

/**
 * Step that runs the AskUserQuestion tool and records the answer into flow
 * state. Dispatched via `ctx.harness.run` because the loop body is typed
 * `Step<string, string>` while `step.tool(askUser)` is typed
 * `Step<AskUserInput, AskUserOutput>`; the current primitive set has no
 * inline adapter. This is the one place we nest a `harness.run` call.
 */
const askAndRecordStep: Step<ContextMemory, string, string> = step.run({
  id: 'code-agent/ask-and-record',
  async execute(input, ctx) {
    const askUser = getAskUserTool(readUnifiedTools(ctx));
    // This step only runs under a branch route that already confirmed an
    // AskUser tool exists, but the defensive check keeps the step composable
    // from other call sites without a nullability hole.
    if (!askUser) {
      return input;
    }
    const askStep = step.tool<ContextMemory, AskUserInput, AskUserOutput>({
      id: 'code-agent/ask-user',
      tool: askUser,
    });
    const state = readFlowState(ctx);
    const askInput = buildApprovalAskInput(state, input);
    const rawResult = await ctx.harness.run(askStep, askInput, ctx);
    const result = AskUserOutputSchema.parse(rawResult);
    const approved = answerLooksApproved(extractApprovalAnswer(result));
    writeFlowState(ctx, {
      ...state,
      mode: approved ? 'act' : 'plan',
      awaitingPlanApproval: false,
      approvalQuestion: undefined,
    });
    await persistFlowState(ctx);
    return approved
      ? 'Plan approved. Act mode is now active.'
      : 'Plan approval was not granted. Stay in plan mode and revise the plan.';
  },
});

/**
 * Step that auto-approves when no AskUserQuestion tool is registered (headless
 * mode). The plan LLM cannot usefully request approval that no-one can grant,
 * so the workflow advances to act mode on the next turn.
 */
const autoApproveStep: Step<ContextMemory, string, string> = step.run({
  id: 'code-agent/auto-approve',
  async execute(_input, ctx) {
    const state = readFlowState(ctx);
    writeFlowState(ctx, {
      ...state,
      mode: 'act',
      awaitingPlanApproval: false,
      approvalQuestion: undefined,
    });
    await persistFlowState(ctx);
    return 'Plan approved automatically (no interactive approval service available). Act mode is now active.';
  },
});

/**
 * Branch selecting between interactive approval and auto-approval based on
 * whether an AskUserQuestion tool is registered. Moving this conditional out
 * of a step.run body into a `branch` keeps flow control inside the noetic
 * primitives.
 */
const askOrAutoApproveBranchStep: Step<ContextMemory, string, string> = branch({
  id: 'code-agent/ask-or-auto-branch',
  route: (_input, ctx) => (hasAskUserQuestion(ctx) ? askAndRecordStep : autoApproveStep),
  _optimizable: frameworkCast<Step<ContextMemory>[]>([
    askAndRecordStep,
    autoApproveStep,
  ]),
});

/**
 * Top-level plan-loop trailing branch. Runs the approval sequence only when
 * the plan LLM invoked `requestPlanApproval` (flipping `awaitingPlanApproval`
 * to `true`); otherwise passes the plan's text through unchanged.
 */
const planApprovalBranchStep: Step<ContextMemory, string, string> = branch({
  id: 'code-agent/plan-approval-branch',
  route: (_input, ctx) =>
    readFlowState(ctx).awaitingPlanApproval === true ? askOrAutoApproveBranchStep : null,
  _optimizable: frameworkCast<Step<ContextMemory>[]>([
    askOrAutoApproveBranchStep,
  ]),
});

//#endregion

//#region Plan agent

export const planAgent: Step<ContextMemory, string, string> = spawn({
  id: 'code-agent/plan-agent',
  child: loop({
    id: 'code-agent/plan-loop',
    steps: [
      step.llm<ContextMemory, string, string>({
        id: 'code-agent/plan-chat',
        model: (ctx: Context<ContextMemory>) => readParam(ctx, 'model', '', isString),
        instructions: (ctx: Context<ContextMemory>) => {
          const user = readParam(ctx, 'instructions', '', isString);
          return [
            user,
            PLAN_SYSTEM_INSTRUCTIONS,
          ]
            .filter(Boolean)
            .join('\n\n');
        },
        tools: (ctx: Context<ContextMemory>) => {
          const filtered = filterToolsByNames(readUnifiedTools(ctx), PLAN_MODE_TOOL_NAMES);
          // Always expose `requestPlanApproval`. The approval branch routes
          // to `askAndRecordStep` when AskUserQuestion is registered, and to
          // `autoApproveStep` otherwise — so the plan LLM's contract is the
          // same in both interactive and headless modes.
          return [
            ...filtered,
            requestPlanApproval,
          ];
        },
      }),
      planApprovalBranchStep,
    ],
    until: until.noToolCalls(),
  }),
});

//#endregion
