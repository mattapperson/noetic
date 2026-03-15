import type { MemoryLayer, MemoryScope } from '../../types/memory';
import type { MessageItem, FunctionCallItem } from '../../types/items';
import { Slot } from '../../types/memory';
import type { ZodType } from 'zod';

export type WorkingMemoryState = string | Record<string, unknown>;

export interface WorkingMemoryConfig {
  scope?: 'thread' | 'resource';
  schema?: ZodType;
  template?: string;
  readOnly?: boolean;
}

export function workingMemory(config?: WorkingMemoryConfig): MemoryLayer<WorkingMemoryState> {
  const scope: MemoryScope = config?.scope ?? 'thread';

  return {
    id: 'working-memory',
    name: 'Working Memory',
    slot: Slot.WORKING_MEMORY,
    scope,
    budget: { min: 200, max: 1500 },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<WorkingMemoryState>('state');
        const state: WorkingMemoryState = saved ?? (config?.schema ? {} : '');
        return { state };
      },

      async recall({ state, budget }) {
        if (
          !state ||
          (typeof state === 'string' && !state) ||
          (typeof state === 'object' && Object.keys(state).length === 0)
        ) {
          return null;
        }
        const text = typeof state === 'string' ? state : JSON.stringify(state, null, 2);
        const content = `<working_memory>\n${text}\n</working_memory>`;
        const item: MessageItem = {
          id: crypto.randomUUID(),
          status: 'completed',
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: content }],
        };
        return { items: [item], tokenCount: Math.ceil(content.length / 4) };
      },

      async store({ newItems, state }) {
        if (config?.readOnly) return;
        // Watch for updateWorkingMemory function calls
        for (const item of newItems) {
          if (
            item.type === 'function_call' &&
            (item as FunctionCallItem).name === 'updateWorkingMemory'
          ) {
            try {
              const raw = JSON.parse((item as FunctionCallItem).arguments);
              if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
              const { __proto__: _p, constructor: _c, ...safeArgs } = raw;
              if (typeof state === 'object' && state !== null) {
                // Deep merge
                const newState = { ...state, ...safeArgs };
                return { state: newState };
              } else {
                return { state: safeArgs };
              }
            } catch {
              // Invalid JSON, skip
            }
          }
        }
        return { state };
      },

      async onSpawn({ parentState }) {
        if (scope === 'resource') {
          return { childState: structuredClone(parentState) };
        }
        return null; // Don't propagate for thread scope
      },
    },
  };
}
