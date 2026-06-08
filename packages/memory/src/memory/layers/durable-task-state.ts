import type { MemoryLayer } from '@noetic-tools/types';
import { createMessage, estimateTokens, Slot } from '@noetic-tools/types';
import type { ZodType } from 'zod';

export interface DurableTaskState {
  checkpoints: Array<{
    timestamp: number;
    depth: number;
  }>;
  files: string[];
  data: Record<string, unknown>;
}

export interface DurableTaskStateSerializer {
  serialize(state: DurableTaskState): string;
  deserialize(data: string): DurableTaskState;
}

export interface DurableTaskStateConfig {
  baseDir?: string;
  gitCommit?: boolean;
  schema?: ZodType;
  serializer?: DurableTaskStateSerializer;
}

/**
 * Creates a memory layer that persists task checkpoints, files, and arbitrary data across iterations.
 *
 * @public
 * @param _config - Optional configuration for base directory, git commit behavior, schema, and serializer.
 * @returns A `MemoryLayer` scoped to the execution with durable task state.
 */
export function durableTaskState(_config?: DurableTaskStateConfig) {
  return {
    id: 'durable-task-state' as const,
    name: 'Durable Task State',
    slot: Slot.WORKING_MEMORY + 10, // 110
    // 'thread' (not 'execution'): the layer's purpose is to persist task state
    // ACROSS executions/iterations within a thread. 'execution' scope rotates
    // its storage key every run, so checkpoints never survived (storeLayers also
    // skips durable persistence for 'execution' scope).
    scope: 'thread',
    budget: {
      min: 100,
      max: 800,
    },
    timeouts: {
      store: 30_000,
    },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<DurableTaskState>('state');
        return {
          state: saved ?? {
            checkpoints: [],
            files: [],
            data: {},
          },
        };
      },

      async recall({ state }) {
        if (!state) {
          return null;
        }
        const text = `<task_state>\n${JSON.stringify(state, null, 2)}\n</task_state>`;
        return {
          items: [
            createMessage(text, 'developer'),
          ],
          tokenCount: estimateTokens(text),
        };
      },

      async store({ state, ctx }) {
        const currentState: DurableTaskState = state ?? {
          checkpoints: [],
          files: [],
          data: {},
        };
        // Add a checkpoint for each store call
        const newState: DurableTaskState = {
          ...currentState,
          checkpoints: [
            ...currentState.checkpoints,
            {
              timestamp: Date.now(),
              depth: ctx.depth,
            },
          ],
        };
        return {
          state: newState,
        };
      },

      async onSpawn({ parentState }) {
        // ALWAYS provides child state (unlike other layers)
        return {
          childState: structuredClone(parentState),
          items: [],
        };
      },

      async onReturn({ childState, parentState }) {
        // Merge child artifacts back to parent
        return {
          parentState: {
            checkpoints: [
              ...parentState.checkpoints,
              ...childState.checkpoints,
            ],
            files: [
              ...new Set([
                ...parentState.files,
                ...childState.files,
              ]),
            ],
            data: {
              ...parentState.data,
              ...childState.data,
            },
          },
        };
      },

      async onComplete({ state, outcome }) {
        if (!state) {
          return;
        }
        return {
          state: {
            ...state,
            data: {
              ...state.data,
              __outcome: outcome,
            },
            checkpoints: [
              ...state.checkpoints,
              {
                timestamp: Date.now(),
                depth: 0,
              },
            ],
          },
        };
      },
    },
  } satisfies MemoryLayer<DurableTaskState>;
}
