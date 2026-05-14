/**
 * Per-teammate inbound-message memory layer.
 *
 * At each child recall, drains the teammate's inbox queue (populated by the
 * parent's `sendMessage` tool calls) and surfaces each message as an
 * `<inbound-message>` developer item, so the teammate sees parent-sent
 * messages between react iterations without any explicit `recv` step.
 *
 * Mirrors the parent-side `teammateInboxLayer` pattern: plain in-memory
 * queue on the registry, drained on recall.
 */

import type { Item, MemoryLayer } from '@noetic-tools/core';
import { Slot } from '@noetic-tools/core';
import type { TeammateRegistry } from '../agents/registry-runtime.js';
import { createDeveloperMessage } from './system-reminder.js';

//#region Options

interface TeammateInboundLayerOpts {
  /** The registry holding the queue. Same instance the parent's tools see. */
  teammates: TeammateRegistry;
  /** This teammate's name (key into `teammates.drainInbound`). */
  name: string;
}

//#endregion

//#region Helpers

function formatInbound(message: string): string {
  return `<inbound-message>\n${message}\n</inbound-message>`;
}

//#endregion

//#region Public API

export function teammateInboundLayer(opts: TeammateInboundLayerOpts): MemoryLayer<null> {
  return {
    id: `teammate-inbound:${opts.name}`,
    name: 'Teammate Inbound',
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
        const messages = opts.teammates.drainInbound(opts.name);
        if (messages.length === 0) {
          return null;
        }
        const items: Item[] = messages.map((m) => createDeveloperMessage(formatInbound(m)));
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
