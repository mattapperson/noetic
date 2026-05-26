/**
 * Drive a generic agent-harness chat session for a detached runner.
 *
 * The loop is intentionally minimal. A "runnable" is any harness
 * driven through the standard `execute()` path plus a single-shot
 * `DetachedSignal` its terminal tool resolves:
 *
 *   1. **Resume spawn** — when `priorItems` is non-empty, seed the
 *      session history and hand control straight to the caller's
 *      signal. The agent's prior turns are already on record; the next
 *      turn comes from external input (IPC `send` frame, autopilot
 *      respawn, etc.) rather than being re-kicked here.
 *   2. **Fresh spawn** — when `priorItems` is empty (or omitted) and
 *      an `initialMessage` is supplied, execute that framing message
 *      as the first turn. The harness's own stream pumps persist the
 *      emitted items via whatever session store the caller wired up.
 *   3. **Post-turn hook** — if `afterFirstTurn` is supplied, run it
 *      once the first turn has settled microtasks. The hook sees
 *      whether the signal already resolved during the turn so it can
 *      short-circuit its own logic (e.g. the stall-nudge helper skips
 *      its nudge when the agent already called a terminal tool).
 *   4. **Await outcome** — finally, return `signal.done`. If no
 *      terminal tool ever resolves it, the signal rejects externally
 *      (SIGTERM handler, process abort) or simply never settles — the
 *      caller owns that concern.
 *
 * The loop has no opinions about where `priorItems` come from, how the
 * `initialMessage` is built, or what the terminal outcome looks like.
 * Task-specific logic (chat.jsonl reads, role framing, stall
 * escalation) lives in the caller and composes via the `afterFirstTurn`
 * hook.
 */

import type { HarnessResponse } from '../../types/harness-result';
import type { ExecuteInput, Item } from '../../types/items';
import type { ExecuteOptions, SessionScope } from '../../types/runtime';
import type { DetachedSignal } from './detached-signal';

//#region Types

/**
 * Minimum harness surface the loop calls into. Defining this
 * structurally keeps the loop loosely coupled — the concrete
 * `AgentHarness<P>` already satisfies the shape, as does a test stub
 * that only stands up `seedSessionHistory` + `execute` + `getAgentResponse`.
 *
 * `getAgentResponse` is REQUIRED because `execute()` only enqueues a
 * message and returns before the turn actually runs. The loop awaits
 * `getAgentResponse(scope)` to observe real turn completion before
 * handing to `afterFirstTurn` — without this, stall detection fires
 * before the agent has produced any output and flags every run as
 * stalled.
 */
export interface RunnableLoopHarness {
  seedSessionHistory(threadId: string, items: ReadonlyArray<Item>): void;
  execute(input: ExecuteInput, options?: ExecuteOptions): Promise<void>;
  getAgentResponse(scope?: SessionScope): Promise<HarnessResponse>;
}

/**
 * Read-only view the `afterFirstTurn` hook uses to decide whether the
 * signal settled during the turn it just observed. Consumers call
 * `signalSettled()` (not a direct property read) so a late-settle
 * caused by microtask ordering still propagates.
 */
export interface AfterFirstTurnContext {
  /** True if `signal.done` has resolved or rejected. */
  signalSettled(): boolean;
}

export interface RunnableLoopOpts<TOutcome> {
  readonly harness: RunnableLoopHarness;
  readonly threadId: string;
  /**
   * Prior session items to seed before the first turn. When non-empty
   * the loop skips `initialMessage` entirely (resume path); when empty
   * or omitted it proceeds with the fresh-spawn sequence.
   */
  readonly priorItems?: ReadonlyArray<Item>;
  /**
   * Developer-role framing message that kicks off a fresh run. Omit to
   * run the loop in "seed + wait" mode where the first turn is driven
   * externally (e.g. by an IPC client's `send` frame).
   */
  readonly initialMessage?: ExecuteInput;
  readonly signal: DetachedSignal<TOutcome>;
  /**
   * Optional post-turn hook. Only runs on the fresh-spawn path once
   * `initialMessage` has settled microtasks. Receives a context whose
   * `signalSettled()` query reflects whether the signal is already
   * resolved/rejected so the hook can no-op when the agent already
   * produced its terminal outcome.
   */
  readonly afterFirstTurn?: (ctx: AfterFirstTurnContext) => Promise<void>;
}

//#endregion

//#region Public API

/**
 * Execute the runnable-loop lifecycle and return the final outcome by
 * awaiting the caller-provided signal. See the module doc for the full
 * sequence; short version:
 *
 *   - `priorItems` present → seed + wait on signal.
 *   - `initialMessage` present → seed (if any) + execute first turn +
 *     run `afterFirstTurn` (if any) + wait on signal.
 *   - Neither present → just wait on signal (pure listener mode).
 */
export async function runnableLoop<TOutcome>(opts: RunnableLoopOpts<TOutcome>): Promise<TOutcome> {
  const prior = opts.priorItems;
  if (prior !== undefined && prior.length > 0) {
    opts.harness.seedSessionHistory(opts.threadId, prior);
    return opts.signal.done;
  }

  if (opts.initialMessage === undefined) {
    return opts.signal.done;
  }

  // Track signal settlement without blocking so the `afterFirstTurn`
  // hook can detect a synchronous resolve that fired during `execute()`
  // without racing the deferred.
  let signalSettled = false;
  void opts.signal.done.then(
    () => {
      signalSettled = true;
    },
    () => {
      signalSettled = true;
    },
  );

  await opts.harness.execute(opts.initialMessage, {
    threadId: opts.threadId,
  });

  // `execute()` only enqueues the framing message; the turn itself runs
  // asynchronously through the session runner. Await `getAgentResponse`
  // to observe REAL turn completion before dispatching `afterFirstTurn`.
  // Without this the stall-nudge hook fires before any turn output and
  // always classifies the run as stalled. We race against `signal.done`
  // so a terminal tool that resolves the signal mid-turn still short-
  // circuits the wait — in that case `getAgentResponse` may not have
  // settled yet and we skip the post-turn hook entirely since the
  // terminal outcome has already fired.
  await Promise.race([
    opts.harness
      .getAgentResponse({
        threadId: opts.threadId,
      })
      .catch(() => undefined),
    opts.signal.done.catch(() => undefined),
  ]);

  if (opts.afterFirstTurn !== undefined) {
    await opts.afterFirstTurn({
      signalSettled: () => signalSettled,
    });
  }

  return opts.signal.done;
}

//#endregion
