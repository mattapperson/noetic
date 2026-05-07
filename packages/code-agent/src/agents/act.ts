/**
 * Act agent — executes the approved plan.
 *
 * Runs the full unified tool pool (including Write/Edit/Bash). After each
 * act turn, `postActCheckStep` counts `git diff --shortstat` lines against
 * the harness cwd and sets flow-state `mode` to `'verify'` when the change
 * exceeds the threshold, else `'done'`. The trailing step also saves the
 * act agent's text to `lastUserText` so if no verify runs the user still
 * sees a useful response.
 */

import type { Context, ContextMemory, Step } from '@noetic/core';
import { loop, spawn, step, until } from '@noetic/core/portable';
import { persistFlowState, readFlowState, writeFlowState } from './flow-state.js';
import {
  DEFAULT_VERIFY_THRESHOLD_LINES,
  isNumber,
  isString,
  readParam,
  readUnifiedTools,
} from './shared.js';

//#region Constants

const ACT_SYSTEM_INSTRUCTIONS =
  'You are the top-level act agent. Implement the approved plan, use sub-agents for bounded parallel work when useful, and verify changes before reporting completion.';

//#endregion

//#region Helpers

/**
 * Extracts insertion + deletion counts from a `git diff --shortstat` line like
 * " 3 files changed, 12 insertions(+), 4 deletions(-)". Returns total lines
 * changed; returns 0 on empty or unparseable output.
 */
export function parseDiffLineCount(stdout: string): number {
  const insertionsMatch = stdout.match(/(\d+)\s+insertions?\(\+\)/);
  const deletionsMatch = stdout.match(/(\d+)\s+deletions?\(-\)/);
  const insertions = insertionsMatch ? Number(insertionsMatch[1]) : 0;
  const deletions = deletionsMatch ? Number(deletionsMatch[1]) : 0;
  return insertions + deletions;
}

//#endregion

//#region Post-act check step

/**
 * Post-act decision step. Counts insertion + deletion lines from
 * `git diff --shortstat` against the harness-rooted cwd and sets the next
 * mode to `'verify'` if the change exceeds the threshold, `'done'` otherwise.
 * Saves the act agent's text to `lastUserText` so if no verify runs the user
 * still sees it.
 */
export const postActCheckStep: Step<ContextMemory, string, string> = step.run({
  id: 'code-agent/post-act-check',
  async execute(input, ctx) {
    const threshold = readParam(ctx, 'verifyThreshold', DEFAULT_VERIFY_THRESHOLD_LINES, isNumber);
    const cwd = ctx.harness.rootCwdState.cwd;
    const diff = await ctx.harness.shell.exec('git diff --shortstat', {
      cwd,
    });
    const lines = parseDiffLineCount(diff.stdout);
    const state = readFlowState(ctx);
    writeFlowState(ctx, {
      ...state,
      mode: lines > threshold ? 'verify' : 'done',
      lastUserText: input,
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
