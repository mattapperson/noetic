import type { ZodType } from 'zod';
import { createMessage, estimateTokens } from '../../interpreter/message-helpers';
import type { MemoryLayer } from '../../types/memory';
import { Slot } from '../../types/memory';

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

export function durableTaskState(_config?: DurableTaskStateConfig): MemoryLayer<DurableTaskState> {
  return {
    id: 'durable-task-state',
    name: 'Durable Task State',
    slot: Slot.WORKING_MEMORY + 10, // 110
    scope: 'execution',
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
  };
}
