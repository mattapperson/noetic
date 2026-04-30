/**
 * Reminder memory layer — injects `<system-reminder>` developer messages based
 * on turn-count throttling + state detection. Sits at Slot.REMINDER (80),
 * just ahead of STEERING.
 *
 * Two pathways:
 *   - `recall()`: fires triggers with `timing: 'recall'`. Output is assembled
 *     into a single developer message via the lifecycle's string-return
 *     convenience path.
 *   - `onItemAppend()`: fires triggers with `timing: 'immediate'`, injecting
 *     additional developer items alongside the input items.
 *
 * The layer also maintains its own state for turn counts, tool-usage history,
 * and consecutive-error tracking — independent of other layers so this layer
 * is self-sufficient.
 */

import type { Item, MemoryLayer } from '@noetic/core';
import { Slot } from '@noetic/core';
import type {
  ReminderLayerState,
  ReminderRegistry,
  ReminderTrigger,
  ReminderTriggerContext,
} from './reminder-triggers.js';
import {
  createDeveloperMessage,
  isAssistantMessage,
  isFunctionCallItem,
  isFunctionCallOutputItem,
  wrapInSystemReminder,
} from './system-reminder.js';

//#region Options

interface ReminderLayerOpts {
  registry: ReminderRegistry;
}

//#endregion

//#region Helpers

const MAX_RECENT_TOOL_NAMES = 10;

function createInitialState(): ReminderLayerState {
  return {
    assistantTurnCount: 0,
    firedHistory: new Map(),
    toolUsageCounts: new Map(),
    recentToolNames: [],
    consecutiveErrorCount: 0,
  };
}

function isThrottled(trigger: ReminderTrigger, state: Readonly<ReminderLayerState>): boolean {
  const last = state.firedHistory.get(trigger.id);
  if (last === undefined) {
    return false;
  }
  const turnsSince = state.assistantTurnCount - last.assistantTurn;
  return turnsSince < trigger.minTurnsBetweenReminders;
}

function markFired(state: ReminderLayerState, triggerId: string, assistantTurn: number): void {
  state.firedHistory.set(triggerId, {
    triggerId,
    assistantTurn,
  });
}

function looksLikeError(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes('error') ||
    lower.includes('failed') ||
    lower.includes('permission denied') ||
    lower.includes('not found')
  );
}

function extractOutputText(item: Item): string {
  if (!isFunctionCallOutputItem(item)) {
    return '';
  }
  return item.output;
}

//#endregion

//#region Public API

export function reminderLayer(opts: ReminderLayerOpts): MemoryLayer<ReminderLayerState> {
  return {
    id: 'reminder',
    name: 'Reminders',
    slot: Slot.REMINDER,
    scope: 'execution',
    budget: {
      min: 0,
      max: 800,
    },
    hooks: {
      async init() {
        return {
          state: createInitialState(),
        };
      },

      async recall({ state, ctx, log }) {
        const messages: string[] = [];
        // Clone the fired-history map so we don't mutate the snapshot passed in.
        const nextFired = new Map(state.firedHistory);
        const working: ReminderLayerState = {
          ...state,
          firedHistory: nextFired,
        };

        for (const trigger of opts.registry.list()) {
          if (trigger.timing !== 'recall') {
            continue;
          }
          if (isThrottled(trigger, working)) {
            continue;
          }
          const tc: ReminderTriggerContext = {
            state: working,
            ctx,
            log,
          };
          const text = trigger.shouldFire(tc);
          if (text === null) {
            continue;
          }
          messages.push(wrapInSystemReminder(text));
          markFired(working, trigger.id, working.assistantTurnCount);
        }

        if (messages.length === 0) {
          return null;
        }

        const body = messages.join('\n\n');
        return {
          items: [
            createDeveloperMessage(body),
          ],
          tokenCount: ctx.tokenize(body),
          state: working,
        };
      },

      async onItemAppend({ items, state, ctx, log }) {
        const injected: Item[] = [];
        const nextFired = new Map(state.firedHistory);
        const working: ReminderLayerState = {
          ...state,
          firedHistory: nextFired,
        };

        for (const trigger of opts.registry.list()) {
          if (trigger.timing !== 'immediate') {
            continue;
          }
          if (isThrottled(trigger, working)) {
            continue;
          }
          const tc: ReminderTriggerContext = {
            state: working,
            ctx,
            log,
          };
          const text = trigger.shouldFire(tc);
          if (text === null) {
            continue;
          }
          injected.push(createDeveloperMessage(wrapInSystemReminder(text)));
          markFired(working, trigger.id, working.assistantTurnCount);
        }

        return {
          items: [
            ...items,
            ...injected,
          ],
          state: working,
        };
      },

      async store({ newItems, state }) {
        let assistantTurnDelta = 0;
        const nextToolCounts = new Map(state.toolUsageCounts);
        const nextRecent = [
          ...state.recentToolNames,
        ];
        let consecutiveErrorCount = state.consecutiveErrorCount;

        for (const item of newItems) {
          if (isAssistantMessage(item)) {
            assistantTurnDelta += 1;
            continue;
          }
          if (isFunctionCallItem(item)) {
            nextToolCounts.set(item.name, (nextToolCounts.get(item.name) ?? 0) + 1);
            nextRecent.push(item.name);
            while (nextRecent.length > MAX_RECENT_TOOL_NAMES) {
              nextRecent.shift();
            }
            continue;
          }
          if (isFunctionCallOutputItem(item)) {
            const text = extractOutputText(item);
            if (text.length > 0 && looksLikeError(text)) {
              consecutiveErrorCount += 1;
            } else {
              consecutiveErrorCount = 0;
            }
          }
        }

        return {
          state: {
            ...state,
            assistantTurnCount: state.assistantTurnCount + assistantTurnDelta,
            toolUsageCounts: nextToolCounts,
            recentToolNames: nextRecent,
            consecutiveErrorCount,
          },
        };
      },
    },
  };
}

//#endregion
