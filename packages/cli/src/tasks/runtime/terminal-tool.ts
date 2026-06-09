/**
 * Shared factory for role-specific terminal tools.
 *
 * Planner and implementer runners expose a pair of "exit" tools each
 * (submit_hierarchy / abandon_planning for planner, signal_impl_done /
 * signal_impl_blocked for implementer). Every one of those tools has
 * the same shape:
 *
 *   1. validate input against a zod schema
 *   2. run a role-specific commit side-effect (persist the result to
 *      disk, fire task-event, etc.)
 *   3. resolve the runner's `DetachedSignal` with a role-specific outcome
 *   4. return a small confirmation payload shaped by a zod output schema
 *
 * `createTerminalTool` captures that skeleton so each concrete tool
 * only has to describe its commit+resolve step. The generic params
 * keep the input/output types flowing through to the caller — no
 * `as`, no `Tool<unknown, unknown>` escape hatches.
 */

import type { DetachedSignal, Tool } from '@noetic-tools/core';
import type { z } from 'zod';

//#region Types

/**
 * Describes a single terminal tool: its wire shape, display metadata,
 * and the role-specific commit step that runs before the tool returns.
 */
export interface TerminalToolSpec<TIn extends z.ZodTypeAny, TOut extends z.ZodTypeAny, TOutcome> {
  readonly name: string;
  readonly description: string;
  readonly input: TIn;
  readonly output: TOut;
  /**
   * The signal this tool resolves when the runner's turn should end.
   * Shared across every terminal tool for a given role — whichever
   * tool is called first wins and the runner loop exits.
   */
  readonly signal: DetachedSignal<TOutcome>;
  /**
   * Role-specific side effect + outcome derivation. Called with the
   * parsed tool input; must return the outcome to resolve the signal
   * with and the output value for the tool response. Exceptions
   * propagate to the caller — the runner framework surfaces them as
   * tool errors.
   */
  readonly commit: (args: z.infer<TIn>) => Promise<{
    readonly outcome: TOutcome;
    readonly output: z.infer<TOut>;
  }>;
}

//#endregion

//#region Public API

/**
 * Build a `Tool` whose `execute` runs the spec's `commit` callback,
 * resolves the runner signal with the returned outcome, and returns
 * the output payload the tool response carries.
 *
 * The signal is resolved exactly once — a second terminal-tool call
 * on the same runner is a no-op because `DetachedSignal` is single-shot.
 */
export function createTerminalTool<TIn extends z.ZodTypeAny, TOut extends z.ZodTypeAny, TOutcome>(
  spec: TerminalToolSpec<TIn, TOut, TOutcome>,
): Tool<TIn, TOut> {
  return {
    name: spec.name,
    description: spec.description,
    input: spec.input,
    output: spec.output,
    execute: async (args) => {
      const { outcome, output } = await spec.commit(args);
      spec.signal.resolve(outcome);
      return output;
    },
  };
}

//#endregion
