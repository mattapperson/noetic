/**
 * Shared primitives used across the plan / act / verify / fix agents.
 *
 * This file holds only constants, typeguards, and context helpers that more
 * than one agent file imports. Agent-specific constants (instructions, tool
 * name sets, schemas) live with their agent.
 */

import type { Context, ContextMemory, FunctionCallItem, Tool } from '@noetic-tools/core';
import type { AskUserTool } from '../tools/ask-user.js';

//#region Constants

/** Default threshold (insertions + deletions) above which act's output is verified. */
export const DEFAULT_VERIFY_THRESHOLD_LINES = 5;

/** Default ceiling on verify→fix iterations before the workflow gives up. */
export const DEFAULT_MAX_FIX_ATTEMPTS = 3;

/** Name of the built-in AskUserQuestion tool (registered when an AskUserService is configured). */
export const ASK_USER_TOOL_NAME = 'AskUserQuestion';

/**
 * Tool names that mutate (or can mutate) the filesystem. Used as a secondary
 * signal alongside the git-diff line delta: verify is only triggered when
 * both the delta exceeds threshold AND the LLM actually invoked a mutating
 * tool in this phase.
 *
 * The set is deliberately coarse — any tool whose INTENT includes possibly
 * writing to disk is included, to avoid the dangerous silent-skip failure
 * mode where a real change leaves the gate closed:
 *
 *  - `Edit`, `Write`: direct writes.
 *  - `Bash`: shell redirection, `sed -i`, `mv`, running `npm install`, etc.
 *  - `agent`: delegates to a sub-agent whose Edit/Write calls land in the
 *    child's `lastStepMeta`, not the parent's — so without this entry, a
 *    delegated edit would escape detection.
 *  - `InteractiveTerminal`: drives TUIs through pilotty; can launch editors,
 *    run shell commands, or trigger file IO indirectly.
 *
 * Pure-read tools (`Read`, `Grep`, `Find`, `Ls`, `AskUserQuestion`, `browser`,
 * `lsp`, `activateSkill`, `sendMessage`, `checkAgent`) stay out.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'Bash',
  'agent',
  'InteractiveTerminal',
]);

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

//#region Change-detection helpers

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

/**
 * Runs `git diff HEAD --shortstat` against the harness root cwd and returns
 * the total insertion + deletion line count. Diffs against HEAD (not the
 * index) so both staged and unstaged changes contribute — if a tool call
 * `git add`s a file mid-phase, those changes still count toward the delta.
 */
export async function countDiffLines(ctx: Context<ContextMemory>): Promise<number> {
  const cwd = ctx.harness.rootCwdState.cwd;
  const diff = await ctx.harness.shell.exec('git diff HEAD --shortstat', {
    cwd,
  });
  return parseDiffLineCount(diff.stdout);
}

/**
 * True when the most recent LLM step invoked any tool in `MUTATING_TOOL_NAMES`.
 * Reads `ctx.lastStepMeta.toolCalls`, which the interpreter populates after
 * each LLM step and before the next step body runs.
 */
export function didCallMutatingTools(ctx: Context<ContextMemory>): boolean {
  const calls: ReadonlyArray<FunctionCallItem> = ctx.lastStepMeta?.toolCalls ?? [];
  return calls.some((call) => MUTATING_TOOL_NAMES.has(call.name));
}

//#endregion
