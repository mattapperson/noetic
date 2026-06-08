/**
 * Two-strike stall-nudge helper composable with `runnableLoop`.
 *
 * A runner's first turn can end without settling the outcome signal
 * and without the agent asking for external input — i.e. the agent
 * stopped without calling either a terminal tool or an ask-user-style
 * tool. That's a soft failure: rather than wait forever, we nudge the
 * agent once to remind it of its options. If the second turn also
 * ends in the same stalled shape we escalate: the caller-supplied
 * `onStall` callback records the escalation (task pause, metrics,
 * whatever the domain demands) and we settle the signal ourselves with
 * a canonical "stalled" outcome so the parent unwinds cleanly.
 *
 * The helper factors the state machine out of the loop so callers can
 * opt in per-runner. Task-specific concerns (how "pending external
 * input" is detected, how escalation is recorded, what outcome
 * represents a stalled failure) stay with the caller and flow in via
 * the config.
 */

import type { InputMessageItem } from '@noetic-tools/types';
import type { DetachedSignal } from './detached-signal';
import type { AfterFirstTurnContext, RunnableLoopHarness } from './runnable-loop';

//#region Constants

/**
 * Default developer-role text sent when the agent finishes a turn
 * without calling a terminal tool or an ask-user tool. Kept short and
 * unambiguous — the agent should be reminded of its options without
 * being lectured. Callers may override via `createNudgeMessage(text)`.
 */
export const DEFAULT_NUDGE_MESSAGE_TEXT =
  'You finished a turn without calling a terminal tool or AskUserQuestion. If you need user input or instruction to continue, call AskUserQuestion now. Otherwise call your terminal tool to complete this phase.';

//#endregion

//#region Types

export interface CreateNudgeMessageOpts {
  /** Unique id for the message so item-log dedupe can distinguish re-spawns. */
  readonly id: string;
  /** Override the developer-role text. Defaults to `DEFAULT_NUDGE_MESSAGE_TEXT`. */
  readonly text?: string;
}

export interface StallNudgeOpts<TOutcome> {
  readonly harness: RunnableLoopHarness;
  readonly threadId: string;
  readonly signal: DetachedSignal<TOutcome>;
  /**
   * The framing message sent as the nudge. Use `createNudgeMessage`
   * for the canonical developer-role item, or pass your own when a
   * domain needs a custom shape.
   */
  readonly nudgeMessage: InputMessageItem;
  /**
   * True when the agent intentionally awaits external input (e.g. an
   * outstanding ask-user request). When true the nudge is suppressed
   * — the agent is not stalled, it is waiting for us.
   */
  hasPendingExternal(): boolean;
  /**
   * Record-side-effect callback fired when the agent stalls a second
   * time. Use this to mark the task paused, emit a metric, append an
   * event log entry — whatever the domain needs before the signal
   * settles.
   */
  onStall(): Promise<void>;
  /** Build the outcome value the signal resolves to on stall escalation. */
  buildStalledOutcome(): TOutcome;
}

//#endregion

//#region Public API

/**
 * Build the canonical developer-role nudge message item. Callers who
 * want a custom framing build their own `InputMessageItem`; this
 * helper exists so the common case stays one line.
 */
export function createNudgeMessage(opts: CreateNudgeMessageOpts): InputMessageItem {
  return {
    id: opts.id,
    type: 'message',
    role: 'developer',
    status: 'completed',
    content: [
      {
        type: 'input_text',
        text: opts.text ?? DEFAULT_NUDGE_MESSAGE_TEXT,
      },
    ],
  };
}

/**
 * Build a `runnableLoop`-compatible `afterFirstTurn` hook that
 * implements the two-strike nudge state machine described in the
 * module doc. The hook is a no-op when:
 *
 *   - the signal already settled (agent called a terminal tool), or
 *   - the caller reports pending external input (`hasPendingExternal`
 *     returns true — e.g. an outstanding ask-user request).
 *
 * Otherwise it sends the nudge message via `harness.execute`, waits
 * for microtasks to flush, and re-checks the same two conditions. If
 * the agent still hasn't progressed, the hook fires `onStall` and
 * resolves the signal with `buildStalledOutcome()`.
 */
export function createStallNudgeHook<TOutcome>(
  opts: StallNudgeOpts<TOutcome>,
): (ctx: AfterFirstTurnContext) => Promise<void> {
  return async (ctx) => {
    if (ctx.signalSettled()) {
      return;
    }
    if (opts.hasPendingExternal()) {
      return;
    }

    // First stall — send one nudge.
    await opts.harness.execute(opts.nudgeMessage, {
      threadId: opts.threadId,
    });
    await Promise.resolve();

    if (ctx.signalSettled()) {
      return;
    }
    if (opts.hasPendingExternal()) {
      return;
    }

    // Second stall — escalate and settle.
    await opts.onStall();
    opts.signal.resolve(opts.buildStalledOutcome());
  };
}

//#endregion
