/**
 * Verify agent — adversarial review of the act agent's changes.
 *
 * Runs read-only exploration tools plus Bash (for running verification
 * scripts or tests). Returns text starting with `PASS` or `FAIL`.
 *
 * `verifyCheckStep` parses the output:
 *   - PASS → mode=done; the prior act `lastUserText` surfaces to the user.
 *   - FAIL + findings hash matches previous OR attempts > cap → mode=done
 *     with a "giving up" note in `lastUserText`.
 *   - Otherwise → mode=fix; `verifyFindings` is saved to seed the fix agent.
 *
 * `verifyAndCheck` composes the verify agent with `verifyCheckStep` as a
 * trivial two-step sequence (`loop` with `maxIterations: 1` + unconditional
 * stop is the current primitive-set idiom for "run these two in order").
 */

import type { Context, ContextMemory, Step } from '@noetic/core';
import { loop, spawn, step, until } from '@noetic/core/portable';
import { persistFlowState, readFlowState, writeFlowState } from './flow-state.js';
import {
  DEFAULT_MAX_FIX_ATTEMPTS,
  filterToolsByNames,
  isNumber,
  isString,
  PLAN_ACT_MAX_ITERATIONS,
  readParam,
  readUnifiedTools,
} from './shared.js';

//#region Constants

/**
 * Tool names the verify (adversarial-review) agent is permitted to call.
 * Read-only exploration plus Bash for running verification scripts.
 */
export const VERIFY_MODE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Read',
  'Grep',
  'Find',
  'Ls',
  'Bash',
]);

const VERIFY_SYSTEM_INSTRUCTIONS = [
  'You are an adversarial reviewer. Your job is to try to break the change, not just confirm it works.',
  'Investigate the current state of the repository using read-only tools. Run tests or verification scripts via Bash where relevant. Do NOT modify project files.',
  '',
  'When you are done, respond with exactly one of two answers on the first line:',
  '  PASS — if you found nothing that needs fixing.',
  '  FAIL — if you found issues.',
  'If FAIL, follow the first line with a specific list of issues, one per paragraph, each describing:',
  '  (a) Check — what you looked at.',
  '  (b) Command / evidence — the command you ran and the observed output.',
  '  (c) Result — why this is a problem.',
].join('\n');

//#endregion

//#region Helpers

function verifyLooksLikePass(findings: string): boolean {
  return findings.trim().toUpperCase().startsWith('PASS');
}

/** Non-cryptographic djb2 hash — adequate for the "did findings repeat?" check. */
export function djb2Hash(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 33) ^ s.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

//#endregion

//#region Verify-check step

/**
 * Processes verify agent output. PASS → mode=done; FAIL with repeated hash or
 * exhausted attempts → mode=done with giving-up note; otherwise → mode=fix
 * with findings saved for the fix agent's instructions.
 */
export const verifyCheckStep: Step<ContextMemory, string, string> = step.run({
  id: 'code-agent/verify-check',
  async execute(findings, ctx) {
    const state = readFlowState(ctx);
    const maxAttempts = readParam(ctx, 'maxFixAttempts', DEFAULT_MAX_FIX_ATTEMPTS, isNumber);

    if (verifyLooksLikePass(findings)) {
      writeFlowState(ctx, {
        ...state,
        mode: 'done',
      });
      await persistFlowState(ctx);
      return findings;
    }

    const hash = djb2Hash(findings);
    const attempts = (state.fixAttempts ?? 0) + 1;
    const giveUp = attempts > maxAttempts || hash === state.lastFindingsHash;

    if (giveUp) {
      const reason =
        attempts > maxAttempts
          ? `Fix loop exceeded ${maxAttempts} attempts; stopping before going in circles.`
          : 'Fix loop produced the same verifier findings twice — the fix may or may not have changed files, but nothing in the observable verifier output improved; stopping to avoid spinning.';
      writeFlowState(ctx, {
        ...state,
        mode: 'done',
        lastUserText: `${reason}\n\nLast verify findings:\n${findings}`,
      });
      await persistFlowState(ctx);
      return findings;
    }

    writeFlowState(ctx, {
      ...state,
      mode: 'fix',
      fixAttempts: attempts,
      lastFindingsHash: hash,
      verifyFindings: findings,
    });
    await persistFlowState(ctx);
    return findings;
  },
});

//#endregion

//#region Verify agent

const verifyAgentInner: Step<ContextMemory, string, string> = spawn({
  id: 'code-agent/verify-agent',
  child: loop({
    id: 'code-agent/verify-loop',
    steps: [
      step.llm<ContextMemory, string, string>({
        id: 'code-agent/verify-chat',
        model: (ctx: Context<ContextMemory>) => readParam(ctx, 'model', '', isString),
        instructions: () => VERIFY_SYSTEM_INSTRUCTIONS,
        tools: (ctx: Context<ContextMemory>) =>
          filterToolsByNames(readUnifiedTools(ctx), VERIFY_MODE_TOOL_NAMES),
      }),
    ],
    until: until.noToolCalls(),
    maxIterations: PLAN_ACT_MAX_ITERATIONS,
  }),
});

/**
 * `verifyAndCheck` composes the verify sub-agent's LLM loop with the
 * `verifyCheckStep` that decides what mode comes next. The outer `loop` with
 * `maxIterations: 1` + unconditional stop is the current primitive-set idiom
 * for "run these two steps in sequence" when no dedicated sequence builder
 * exists.
 */
export const verifyAndCheck: Step<ContextMemory, string, string> = loop({
  id: 'code-agent/verify-and-check',
  steps: [
    verifyAgentInner,
    verifyCheckStep,
  ],
  until: () => ({
    stop: true,
    reason: 'one verify pass complete',
  }),
  maxIterations: 1,
});

/**
 * Exported reference to the inner verify agent for optimizer traversal.
 * The workflow's `_optimizable` list includes this so `collectAllTools`
 * can walk into the verify sub-graph.
 */
export const verifyAgent = verifyAgentInner;

//#endregion
