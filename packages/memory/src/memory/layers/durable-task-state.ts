import type { MemoryLayer } from '@noetic-tools/types';
import { createMessage, estimateTokens, Slot } from '@noetic-tools/types';

export interface DurableTaskState {
  checkpoints: Array<{
    timestamp: number;
    depth: number;
  }>;
  files: string[];
  data: Record<string, unknown>;
}

/**
 * Hard cap on retained checkpoints. store() appends one per model call and
 * onReturn concatenates the child's list, so without a cap the thread-scoped
 * (durably persisted) array grows linearly with total model calls forever.
 * Newest checkpoints are kept.
 */
const MAX_CHECKPOINTS = 50;

function trimCheckpoints(
  checkpoints: DurableTaskState['checkpoints'],
): DurableTaskState['checkpoints'] {
  if (checkpoints.length <= MAX_CHECKPOINTS) {
    return checkpoints;
  }
  return checkpoints.slice(checkpoints.length - MAX_CHECKPOINTS);
}

function renderTaskState(state: DurableTaskState): string {
  return `<task_state>\n${JSON.stringify(state, null, 2)}\n</task_state>`;
}

/**
 * Creates a memory layer that persists task checkpoints, files, and arbitrary data across iterations.
 *
 * State is rehydrated from `ScopedStorage` on init and persisted via the
 * runtime's durable write-through; `store` appends capped checkpoints
 * (newest 50 kept) and `recall` trims its render to the allocated budget.
 *
 * @public
 * @returns A `MemoryLayer` scoped to the thread with durable task state.
 */
export function durableTaskState() {
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

      async recall({ state, budget }) {
        if (!state) {
          return null;
        }
        let view = state;
        let text = renderTaskState(view);
        // `budget > 0` is the fail-open convention (see staticContent): a zero
        // allocation must not delete the task state from the view.
        if (budget > 0) {
          // Halve the OLDEST checkpoints while the render exceeds the budget —
          // files/data stay, recent checkpoints stay.
          while (estimateTokens(text) > budget && view.checkpoints.length > 0) {
            view = {
              ...view,
              checkpoints: view.checkpoints.slice(Math.ceil(view.checkpoints.length / 2)),
            };
            text = renderTaskState(view);
          }
          // Final guard: still over budget with no checkpoints left — char-slice
          // and keep the closing tag so the block stays well-formed.
          if (estimateTokens(text) > budget) {
            const closing = '\n</task_state>';
            const maxChars = Math.max(0, budget * 4 - closing.length);
            text = `${text.slice(0, maxChars)}${closing}`;
          }
        }
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
        // Add a checkpoint for each store call (capped, newest kept)
        const newState: DurableTaskState = {
          ...currentState,
          checkpoints: trimCheckpoints([
            ...currentState.checkpoints,
            {
              timestamp: Date.now(),
              depth: ctx.depth,
            },
          ]),
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
        // Merge child artifacts back to parent. The parent may have no state
        // (init-less / never-initialized) — seed an empty base so the child's
        // contribution is still merged rather than crashing.
        const parent = parentState ?? {
          checkpoints: [],
          files: [],
          data: {},
        };
        return {
          parentState: {
            checkpoints: trimCheckpoints([
              ...parent.checkpoints,
              ...childState.checkpoints,
            ]),
            files: [
              ...new Set([
                ...parent.files,
                ...childState.files,
              ]),
            ],
            data: {
              ...parent.data,
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
            checkpoints: trimCheckpoints([
              ...state.checkpoints,
              {
                timestamp: Date.now(),
                depth: 0,
              },
            ]),
          },
        };
      },
    },
  } satisfies MemoryLayer<DurableTaskState>;
}
