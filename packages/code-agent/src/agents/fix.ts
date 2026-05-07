/**
 * Fix agent — addresses issues the verify agent flagged.
 *
 * Runs with the full unified tool pool (same as act). Instructions include
 * the prior `verifyFindings` from flow state. The trailing `fixCompleteStep`
 * records the fix agent's text as `lastUserText` and sets mode=verify so the
 * outer loop routes back for re-verification.
 */

import type { Context, ContextMemory, Step } from '@noetic/core';
import { loop, spawn, step, until } from '@noetic/core/portable';
import { persistFlowState, readFlowState, writeFlowState } from './flow-state.js';
import { isString, readParam, readUnifiedTools } from './shared.js';

//#region Constants

const FIX_SYSTEM_INSTRUCTIONS =
  'You are the fix agent. The verify agent flagged the following issues. Address each one, run relevant checks, and report what you changed.';

//#endregion

//#region Fix-complete step

/**
 * Trailing fix-agent step: records the fix agent's text as the current
 * user-visible output (so if verify PASSes next it's what the user sees),
 * then sets mode=verify so the outer loop routes back for re-verification.
 */
export const fixCompleteStep: Step<ContextMemory, string, string> = step.run({
  id: 'code-agent/fix-complete',
  async execute(input, ctx) {
    const state = readFlowState(ctx);
    writeFlowState(ctx, {
      ...state,
      mode: 'verify',
      lastUserText: input,
    });
    await persistFlowState(ctx);
    return input;
  },
});

//#endregion

//#region Fix agent

export const fixAgent: Step<ContextMemory, string, string> = spawn({
  id: 'code-agent/fix-agent',
  child: loop({
    id: 'code-agent/fix-loop',
    steps: [
      step.llm<ContextMemory, string, string>({
        id: 'code-agent/fix-chat',
        model: (ctx: Context<ContextMemory>) => readParam(ctx, 'model', '', isString),
        instructions: (ctx: Context<ContextMemory>) => {
          const user = readParam(ctx, 'instructions', '', isString);
          const state = readFlowState(ctx);
          const findings = state.verifyFindings ?? '';
          return [
            user,
            FIX_SYSTEM_INSTRUCTIONS,
            `Verify findings:\n${findings}`,
          ]
            .filter(Boolean)
            .join('\n\n');
        },
        tools: readUnifiedTools,
      }),
      fixCompleteStep,
    ],
    until: until.noToolCalls(),
  }),
});

//#endregion
