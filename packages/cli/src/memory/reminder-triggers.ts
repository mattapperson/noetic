/**
 * Reminder trigger registry + built-in triggers.
 *
 * A `ReminderTrigger` is a small, named rule that decides whether to emit a
 * `<system-reminder>`-wrapped developer message into the next turn. Triggers
 * are dual-counter throttled (assistant-turn clock + per-trigger last-fired
 * clock), matching Claude Code's behavior from `attachments.ts:3266`.
 *
 * Two timings are supported:
 *   - `'recall'`: fires during the next `recall()` pass (common case — the
 *     reminder shows up at the top of the next turn's assembly).
 *   - `'immediate'`: fires during `onItemAppend()` so the reminder is
 *     injected alongside the triggering input item(s).
 */

import type { ExecutionContext, ItemLog } from '@noetic/core';

//#region State (used by the layer; exported so triggers can type their context)

export interface ReminderLayerState {
  /** Monotonic counter of assistant-authored turns. Incremented in `store()`. */
  assistantTurnCount: number;
  /** Per-trigger record of the turn-index at which the reminder last fired. */
  firedHistory: Map<
    string,
    {
      triggerId: string;
      assistantTurn: number;
    }
  >;
  /** Cumulative tool-usage counts, for triggers that react to patterns. */
  toolUsageCounts: Map<string, number>;
  /** Most-recent sequence of tool-call names, for "consecutive X" detection. */
  recentToolNames: string[];
  /** Consecutive tool-error streak tracked across tool outputs. */
  consecutiveErrorCount: number;
}

//#endregion

//#region Trigger contract

/** Context passed to a trigger's `shouldFire` implementation. */
export interface ReminderTriggerContext {
  state: Readonly<ReminderLayerState>;
  ctx: ExecutionContext;
  log: ItemLog;
}

/** A single reminder rule. */
export interface ReminderTrigger {
  /** Unique id. Duplicates throw on `register`. */
  id: string;
  /** Minimum assistant turns between firings. */
  minTurnsBetweenReminders: number;
  /** `'recall'` fires on next turn; `'immediate'` fires inside `onItemAppend`. */
  timing: 'recall' | 'immediate';
  /** Return the raw message (without `<system-reminder>` wrap) or `null` to skip. */
  shouldFire(tc: ReminderTriggerContext): string | null;
}

//#endregion

//#region Registry

export interface ReminderRegistry {
  register(trigger: ReminderTrigger): void;
  list(): ReadonlyArray<ReminderTrigger>;
}

export function createReminderRegistry(): ReminderRegistry {
  const triggers: ReminderTrigger[] = [];
  const ids = new Set<string>();
  return {
    register(trigger: ReminderTrigger): void {
      if (ids.has(trigger.id)) {
        throw new Error(`ReminderRegistry: duplicate trigger id "${trigger.id}"`);
      }
      ids.add(trigger.id);
      triggers.push(trigger);
    },
    list(): ReadonlyArray<ReminderTrigger> {
      return triggers;
    },
  };
}

//#endregion

//#region Shape guards for cross-layer reads

/**
 * `ExecutionContext.readLayerState<T>` does not validate `T` at runtime — the
 * generic is a convenience cast. Sibling layers may register under the same
 * id with an arbitrary state shape, so every cross-layer read must re-check
 * before dereferencing. These guards centralise the defensive checks.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function hasSources(value: unknown): value is {
  sources: ReadonlyArray<unknown>;
} {
  return isRecord(value) && Array.isArray(value.sources);
}

function extractPlanMode(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const session = value.session;
  if (isRecord(session) && typeof session.mode === 'string') {
    return session.mode;
  }
  if (typeof value.mode === 'string') {
    return value.mode;
  }
  return null;
}

//#endregion

//#region Built-in triggers

/** Fires once on turn 0 after AGENT.md has loaded, to flag its presence. */
const agentMdLoadedTrigger: ReminderTrigger = {
  id: 'agent-md-loaded',
  minTurnsBetweenReminders: Number.POSITIVE_INFINITY,
  timing: 'recall',
  shouldFire({ state, ctx }): string | null {
    if (state.assistantTurnCount !== 0) {
      return null;
    }
    const agentMd = ctx.readLayerState('agent-md');
    if (!hasSources(agentMd) || agentMd.sources.length === 0) {
      return null;
    }
    return 'AGENT.md and rules files are loaded into context. Follow the rules and preferences they declare for the duration of this session.';
  },
};

/** Nags the model every 8 turns while planning mode is active. */
const planModeStillActiveTrigger: ReminderTrigger = {
  id: 'plan-mode-still-active',
  minTurnsBetweenReminders: 8,
  timing: 'recall',
  shouldFire({ ctx }): string | null {
    const mode = extractPlanMode(ctx.readLayerState('plan-memory'));
    if (mode !== 'planning') {
      return null;
    }
    return 'Plan mode is still active — mutating tools are disabled. Finish planning with `plan/exitPlanMode` before attempting implementation.';
  },
};

/** Periodically reminds the model in long conversations. */
const longConversationTrigger: ReminderTrigger = {
  id: 'long-conversation',
  minTurnsBetweenReminders: 40,
  timing: 'recall',
  shouldFire({ state }): string | null {
    if (state.assistantTurnCount < 40) {
      return null;
    }
    return "This conversation has been running for a while. Re-read the user's most recent ask before each step — do not drift from the current goal or repeat completed work.";
  },
};

/**
 * Fires immediately after three consecutive tool results contain errors.
 * Uses `'immediate'` timing so the reminder rides with the failing output.
 */
const errorRecoveryTrigger: ReminderTrigger = {
  id: 'error-recovery',
  minTurnsBetweenReminders: 3,
  timing: 'immediate',
  shouldFire({ state }): string | null {
    if (state.consecutiveErrorCount < 3) {
      return null;
    }
    return 'Three consecutive tool calls have failed. Diagnose the root cause — read the error text, check your assumptions, consider whether a different tool or a user clarification would unblock you — before retrying.';
  },
};

/** After 3 Bash calls in a row, suggests switching to a dedicated tool. */
const consecutiveBashTrigger: ReminderTrigger = {
  id: 'consecutive-bash',
  minTurnsBetweenReminders: 4,
  timing: 'recall',
  shouldFire({ state }): string | null {
    const lastThree = state.recentToolNames.slice(-3);
    if (lastThree.length < 3) {
      return null;
    }
    if (!lastThree.every((n) => n === 'Bash')) {
      return null;
    }
    return 'You have called Bash three times in a row. Consider whether the next step is really a shell command, or whether Read / Edit / Write / Grep / Find / Ls would be a better fit.';
  },
};

export const BUILTIN_TRIGGERS: ReadonlyArray<ReminderTrigger> = [
  agentMdLoadedTrigger,
  planModeStillActiveTrigger,
  longConversationTrigger,
  errorRecoveryTrigger,
  consecutiveBashTrigger,
];

//#endregion
