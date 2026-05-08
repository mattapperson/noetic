/**
 * Fix agent — addresses issues the verify agent flagged.
 *
 * Runs with the full unified tool pool (same as act). Instructions include
 * the prior `verifyFindings` from flow state. Mirrors act's phase-entry /
 * phase-exit pattern: `preFixCaptureStep` idempotently snapshots the current
 * diff line count as the fix-phase baseline, and `fixCompleteStep` only
 * routes back to verify when the delta since that baseline exceeds threshold
 * AND a mutating tool was invoked. A fix turn that produced no observable
 * filesystem change goes to done rather than spinning verify again.
 */

import type { Context, ContextMemory, Step } from '@noetic/core';
import { loop, spawn, step, until } from '@noetic/core/portable';
import { persistFlowState, readFlowState, writeFlowState } from './flow-state.js';
import {
  countDiffLines,
  DEFAULT_VERIFY_THRESHOLD_LINES,
  didCallMutatingTools,
  isNumber,
  isString,
  readParam,
  readUnifiedTools,
} from './shared.js';

//#region Constants

const FIX_SYSTEM_INSTRUCTIONS =
  'You are the fix agent. The verify agent flagged the following issues. Address each one, run relevant checks, and report what you changed.';

//#endregion

//#region Pre-fix capture step

/**
 * Records the current diff line count as the fix-phase baseline and resets
 * the mutation flag. Idempotent — second+ iterations within one fix phase
 * leave the baseline intact, so it always reflects phase entry.
 */
export const preFixCaptureStep: Step<ContextMemory, string, string> = step.run({
  id: 'code-agent/pre-fix-capture',
  async execute(input, ctx) {
    const state = readFlowState(ctx);
    if (state.fixBaselineLines !== undefined) {
      return input;
    }
    const lines = await countDiffLines(ctx);
    writeFlowState(ctx, {
      ...state,
      fixBaselineLines: lines,
      fixDidMutateTools: false,
    });
    await persistFlowState(ctx);
    return input;
  },
});

//#endregion

//#region Fix-complete step

/**
 * Trailing fix-agent step: records the fix agent's text as the current
 * user-visible output and decides whether a reverify is warranted. Mirrors
 * `postActCheckStep`: routes to verify only when the fix phase produced a
 * line-count delta above threshold AND invoked a mutating tool; otherwise
 * ends the workflow at done. This avoids the degenerate fix→verify→fix
 * spin when the fix agent produces no observable changes.
 */
export const fixCompleteStep: Step<ContextMemory, string, string> = step.run({
  id: 'code-agent/fix-complete',
  async execute(input, ctx) {
    const threshold = readParam(ctx, 'verifyThreshold', DEFAULT_VERIFY_THRESHOLD_LINES, isNumber);
    const state = readFlowState(ctx);
    const baseline = state.fixBaselineLines ?? 0;
    const currentLines = await countDiffLines(ctx);
    const delta = currentLines - baseline;
    const mutatedThisIteration = didCallMutatingTools(ctx);
    const mutatedThisPhase = Boolean(state.fixDidMutateTools) || mutatedThisIteration;
    const shouldReverify = delta > threshold && mutatedThisPhase;
    writeFlowState(ctx, {
      ...state,
      mode: shouldReverify ? 'verify' : 'done',
      lastUserText: input,
      fixDidMutateTools: mutatedThisPhase,
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
      preFixCaptureStep,
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
