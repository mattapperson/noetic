/**
 * Act agent — executes the approved plan.
 *
 * Runs the full unified tool pool (including Write/Edit/Bash). Each act loop
 * iteration begins with `preActCaptureStep`, which idempotently snapshots the
 * current `git diff --shortstat` line count as the phase baseline. After each
 * iteration, `postActCheckStep` computes the delta against that baseline AND
 * checks whether any mutating tool was invoked in this iteration, then routes
 * to `verify` only when both signals agree (delta > threshold AND a mutating
 * tool ran at some point during the phase). This prevents pre-existing dirty
 * working trees from falsely triggering verify on no-op act turns.
 */

import type { Context, ContextMemory, Step } from '@noetic-tools/core';
import { loop, spawn, step, until } from '@noetic-tools/core/portable';
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

const ACT_SYSTEM_INSTRUCTIONS =
  'You are the top-level act agent. Implement the approved plan, use sub-agents for bounded parallel work when useful, and verify changes before reporting completion.';

//#endregion

//#region Pre-act capture step

/**
 * Records the current diff line count as the act-phase baseline and resets the
 * mutation flag. Idempotent: if the baseline is already set (second+ iteration
 * of the act loop within one phase) it's a no-op, so the baseline represents
 * the state at phase entry, not at every iteration.
 */
export const preActCaptureStep: Step<ContextMemory, string, string> = step.run({
  id: 'code-agent/pre-act-capture',
  async execute(input, ctx) {
    const state = readFlowState(ctx);
    if (state.actBaselineLines !== undefined) {
      return input;
    }
    const lines = await countDiffLines(ctx);
    writeFlowState(ctx, {
      ...state,
      actBaselineLines: lines,
      actDidMutateTools: false,
    });
    await persistFlowState(ctx);
    return input;
  },
});

//#endregion

//#region Post-act check step

/**
 * Post-act decision step. Computes the delta between the current diff line
 * count and the phase baseline captured by `preActCaptureStep`, and checks
 * whether any mutating tool ran this phase (`ctx.lastStepMeta.toolCalls` on
 * the current iteration OR an earlier iteration that already set the flag).
 * Routes to verify only when both signals agree; otherwise goes to done.
 * Saves the act agent's text to `lastUserText` so the user sees it if the
 * workflow ends here.
 */
export const postActCheckStep: Step<ContextMemory, string, string> = step.run({
  id: 'code-agent/post-act-check',
  async execute(input, ctx) {
    const threshold = readParam(ctx, 'verifyThreshold', DEFAULT_VERIFY_THRESHOLD_LINES, isNumber);
    const state = readFlowState(ctx);
    const baseline = state.actBaselineLines ?? 0;
    const currentLines = await countDiffLines(ctx);
    const delta = currentLines - baseline;
    const mutatedThisIteration = didCallMutatingTools(ctx);
    const mutatedThisPhase = Boolean(state.actDidMutateTools) || mutatedThisIteration;
    const shouldVerify = delta > threshold && mutatedThisPhase;
    writeFlowState(ctx, {
      ...state,
      mode: shouldVerify ? 'verify' : 'done',
      lastUserText: input,
      actDidMutateTools: mutatedThisPhase,
    });
    await persistFlowState(ctx);
    return input;
  },
});

//#endregion

//#region Act agent

export const actAgent: Step<ContextMemory, string, string> = spawn({
  id: 'code-agent/act-agent',
  child: loop({
    id: 'code-agent/act-loop',
    steps: [
      preActCaptureStep,
      step.llm<ContextMemory, string, string>({
        id: 'code-agent/act-chat',
        model: (ctx: Context<ContextMemory>) => readParam(ctx, 'model', '', isString),
        instructions: (ctx: Context<ContextMemory>) => {
          const user = readParam(ctx, 'instructions', '', isString);
          return [
            user,
            ACT_SYSTEM_INSTRUCTIONS,
          ]
            .filter(Boolean)
            .join('\n\n');
        },
        tools: readUnifiedTools,
      }),
      postActCheckStep,
    ],
    until: until.noToolCalls(),
  }),
});

//#endregion
