/**
 * Teammate inbox-drain memory layer — at the start of every parent turn,
 * drains pending completion / failure notices from the `TeammateRegistry`'s
 * parent-notice queue (written by `notifyOnSettle` in the `agent` tool) and
 * surfaces them as `<task-notification>` developer messages so the parent
 * model sees them automatically without having to call `checkAgent`.
 *
 * Sits at `Slot.REMINDER` next to the other system-reminder layers.
 *
 * The notice queue is a plain array on the registry (not a `Channel<T>`)
 * because memory layer hooks receive `ExecutionContext`, which does not
 * expose `tryRecv`. The teammate-side inbox (`sendMessage` target) remains
 * a Channel because the teammate consumes it as a step.
 */

import type { Item, MemoryLayer } from '@noetic-tools/core';
import { Slot } from '@noetic-tools/core';
import type { TeammateRegistry } from '../agents/registry-runtime.js';
import { createDeveloperMessage } from './system-reminder.js';

//#region Options

interface TeammateInboxLayerOpts {
  teammates: TeammateRegistry;
}

//#endregion

//#region Helpers

function formatNotification(notice: string): string {
  return `<task-notification>\n${notice}\n</task-notification>`;
}

//#endregion

//#region Public API

export function teammateInboxLayer(opts: TeammateInboxLayerOpts): MemoryLayer<null> {
  return {
    id: 'teammate-inbox',
    name: 'Teammate Inbox',
    slot: Slot.REMINDER,
    scope: 'execution',
    budget: {
      min: 0,
      max: 2_000,
    },
    hooks: {
      async init() {
        return {
          state: null,
        };
      },

      async recall({ ctx }) {
        const messages = opts.teammates.drainNotices();
        if (messages.length === 0) {
          return null;
        }
        const items: Item[] = messages.map((m) => createDeveloperMessage(formatNotification(m)));
        const tokenCount = messages.reduce((sum, m) => sum + ctx.tokenize(m), 0);
        return {
          items,
          tokenCount,
          state: null,
        };
      },
    },
  };
}

//#endregion
