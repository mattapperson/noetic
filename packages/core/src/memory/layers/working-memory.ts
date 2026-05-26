import type { ZodType } from 'zod';
import { z } from 'zod';
import type { MemoryLayer, MemoryScope } from '../../types/memory';
import { Slot } from '../../types/memory';
import { createMessage, estimateTokens } from '../../util/message-helpers';
import { findFunctionCall } from '../function-call-utils';
import { layerData, layerFn } from '../layer-provides';

export type WorkingMemoryState = string | Record<string, unknown>;

export interface WorkingMemoryConfig {
  scope?: 'thread' | 'resource';
  schema?: ZodType;
  template?: string;
  readOnly?: boolean;
}

function safeMerge(state: WorkingMemoryState, args: Record<string, unknown>): WorkingMemoryState {
  const { __proto__: _p, constructor: _c, ...safeArgs } = args;
  if (typeof state === 'object' && state !== null) {
    return {
      ...state,
      ...safeArgs,
    };
  }
  return safeArgs;
}

/**
 * Creates a mutable working memory layer that the model can update via the `working-memory/update` tool.
 *
 * @public
 * @param config - Optional configuration for scope, Zod schema, template, and read-only mode.
 * @returns A `MemoryLayer` providing scratchpad state the model can read and write.
 */
export function workingMemory(config?: WorkingMemoryConfig) {
  const scope: MemoryScope = config?.scope ?? 'thread';

  return {
    id: 'working-memory' as const,
    name: 'Working Memory',
    slot: Slot.WORKING_MEMORY,
    scope,
    budget: {
      min: 200,
      max: 1_500,
    },
    provides: {
      snapshot: layerData<WorkingMemoryState, WorkingMemoryState>({
        read: (state) => state,
      }),
      update: layerFn<Record<string, unknown>, void, WorkingMemoryState>({
        description: 'Update the agent working memory with new key-value pairs.',
        input: z.record(z.string(), z.unknown()),
        output: z.void(),
        execute: async (args, state) => ({
          result: undefined,
          state: safeMerge(state, args),
        }),
      }),
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
        if (!state || (typeof state === 'object' && Object.keys(state).length === 0)) {
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
        // Backward compat: detect implicit updateWorkingMemory calls from LLMs
        const args = findFunctionCall(newItems, 'updateWorkingMemory');
        if (!args) {
          return;
        }
        return {
          state: safeMerge(state, args),
        };
      },

      async onSpawn({ parentState }) {
        if (scope === 'resource') {
          return {
            childState: structuredClone(parentState),
          };
        }
        return null;
      },
    },
  } satisfies MemoryLayer<WorkingMemoryState>;
}
