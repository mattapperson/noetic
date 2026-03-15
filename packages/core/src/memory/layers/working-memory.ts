import type { ZodType } from 'zod';
import { createMessage, estimateTokens } from '../../interpreter/message-helpers';
import type { MemoryLayer, MemoryScope } from '../../types/memory';
import { Slot } from '../../types/memory';

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
    budget: {
      min: 200,
      max: 1_500,
    },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<WorkingMemoryState>('state');
        const state: WorkingMemoryState = saved ?? (config?.schema ? {} : '');
        return {
          state,
        };
      },

      async recall({ state }) {
        if (
          !state ||
          (typeof state === 'string' && !state) ||
          (typeof state === 'object' && Object.keys(state).length === 0)
        ) {
          return null;
        }
        const text = typeof state === 'string' ? state : JSON.stringify(state, null, 2);
        const content = `<working_memory>\n${text}\n</working_memory>`;
        return {
          items: [
            createMessage(content, 'developer'),
          ],
          tokenCount: estimateTokens(content),
        };
      },

      async store({ newItems, state }) {
        if (config?.readOnly) {
          return;
        }
        // Watch for updateWorkingMemory function calls
        for (const item of newItems) {
          if (item.type !== 'function_call') {
            continue;
          }
          if (item.name === 'updateWorkingMemory') {
            try {
              const raw = JSON.parse(item.arguments);
              if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
                continue;
              }
              const { __proto__: _p, constructor: _c, ...safeArgs } = raw;
              if (typeof state === 'object' && state !== null) {
                // Shallow merge: top-level keys from safeArgs overwrite state keys
                const newState = {
                  ...state,
                  ...safeArgs,
                };
                return {
                  state: newState,
                };
              }
              return {
                state: safeArgs,
              };
            } catch {
              // Invalid JSON, skip
            }
          }
        }
        // No updateWorkingMemory call found — return undefined to skip unnecessary store.set
      },

      async onSpawn({ parentState }) {
        if (scope === 'resource') {
          return {
            childState: structuredClone(parentState),
          };
        }
        return null; // Don't propagate for thread scope
      },
    },
  };
}
