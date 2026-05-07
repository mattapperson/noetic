/**
 * Shared primitives used across the plan / act / verify / fix agents.
 *
 * This file holds only constants, typeguards, and context helpers that more
 * than one agent file imports. Agent-specific constants (instructions, tool
 * name sets, schemas) live with their agent.
 */

import type { Context, ContextMemory, Tool } from '@noetic/core';
import type { AskUserTool } from '../tools/ask-user.js';

//#region Constants

/** Default threshold (insertions + deletions) above which act's output is verified. */
export const DEFAULT_VERIFY_THRESHOLD_LINES = 5;

/** Default ceiling on verify→fix iterations before the workflow gives up. */
export const DEFAULT_MAX_FIX_ATTEMPTS = 3;

/** Name of the built-in AskUserQuestion tool (registered when an AskUserService is configured). */
export const ASK_USER_TOOL_NAME = 'AskUserQuestion';

/**
 * Sentinel returned by the `done` step to signal the act/verify/fix loop that
 * the workflow has finished. Checked via `until.outputContains` on the inner
 * loop, never surfaces to the user — the wrapping `step.run` replaces it with
 * the cumulative `lastUserText` before returning.
 */
export const CODE_AGENT_DONE_SENTINEL = '<<<code-agent-done>>>';

//#endregion

//#region Type guards

export function isString(v: unknown): v is string {
  return typeof v === 'string';
}

export function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Narrows a generic `Tool` to `AskUserTool` by checking its registered name.
 * Identity check is sufficient — `AskUserQuestion` is the stable, framework-
 * level identifier for the ask-user tool and the only tool registered under
 * that name.
 */
export function isAskUserTool(t: Tool): t is AskUserTool {
  return t.name === ASK_USER_TOOL_NAME;
}

//#endregion

//#region Context helpers

/** Typed read of a harness param with fallback + runtime typeguard. */
export function readParam<T>(
  ctx: Context<ContextMemory>,
  key: string,
  fallback: T,
  guard: (v: unknown) => v is T,
): T {
  const raw = ctx.harness.config.params[key];
  return guard(raw) ? raw : fallback;
}

/** Mutable snapshot of the context's unified tool pool. */
export function readUnifiedTools(ctx: Context<ContextMemory>): Tool[] {
  const unified = ctx.unifiedTools;
  return unified
    ? [
        ...unified,
      ]
    : [];
}

export function getAskUserTool(tools: ReadonlyArray<Tool>): AskUserTool | undefined {
  return tools.find(isAskUserTool);
}

export function hasAskUserQuestion(ctx: Context<ContextMemory>): boolean {
  return getAskUserTool(readUnifiedTools(ctx)) !== undefined;
}

export function filterToolsByNames(
  tools: ReadonlyArray<Tool>,
  allowed: ReadonlySet<string>,
): Tool[] {
  return tools.filter((t) => allowed.has(t.name));
}

//#endregion
