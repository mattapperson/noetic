import type { ContextLayer } from '@noetic-tools/types';
import { createMessage, estimateTokens, Slot } from '@noetic-tools/types';
import { z } from 'zod';
import { layerFunction } from '../layer-provides';

export interface DurableTaskState {
  checkpoints: Array<{
    timestamp: number;
    depth: number;
  }>;
  files: string[];
  data: Record<string, unknown>;
}

/**
 * How a child's `data` map is merged into the parent's at a spawn/inParallel return.
 *
 * - `'shallow'` — `{ ...parent, ...child }`. Concurrent children that write the
 *   same key clobber each other (last to return wins). Fine for a single child.
 * - `'namespace'` — the child's map is stored whole under its execution id
 *   (`parent.data[childExecutionId] = childData`), so N fan-out workers each
 *   keep their own result. Keys the child inherited from the parent unchanged
 *   are not re-written at the top level.
 *
 * @public
 */
export type DurableTaskDataMerge = 'shallow' | 'namespace';

/** @public Options for {@link taskState}. */
export interface DurableTaskStateOptions {
  /**
   * Merge strategy for `data` at a child boundary. Defaults to `'shallow'`.
   * Use `'namespace'` for coordinator/worker fan-out, where several children
   * return concurrently into one parent.
   */
  mergeData?: DurableTaskDataMerge;
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

function mergeChildData({
  parent,
  childState,
  childExecutionId,
  mergeData,
}: {
  parent: DurableTaskState;
  childState: DurableTaskState;
  childExecutionId: string;
  mergeData: DurableTaskDataMerge;
}): Record<string, unknown> {
  if (mergeData === 'shallow') {
    return {
      ...parent.data,
      ...childState.data,
    };
  }
  return {
    ...parent.data,
    [childExecutionId]: childState.data,
  };
}

/**
 * Creates a context layer that persists task checkpoints, files, and arbitrary data across iterations.
 *
 * State is rehydrated from `ScopedStorage` on init and persisted via the
 * runtime's durable write-through; `store` appends capped checkpoints
 * (newest 50 kept) and `recall` trims its render to the allocated budget.
 *
 * The layer is writable from the model: `provides` exposes
 * `task-state/recordArtifact` (append a produced/modified file path)
 * and `task-state/setTaskData` (record a structured result under a
 * key). Both survive the spawn boundary — a worker's artifacts merge back into
 * its coordinator via `onReturn`.
 *
 * @public
 * @param opts - Layer options; `mergeData` selects the `data` merge strategy at a child boundary.
 * @returns A `ContextLayer` scoped to the thread with durable task state.
 */
export function taskState(opts: DurableTaskStateOptions = {}) {
  const mergeData: DurableTaskDataMerge = opts.mergeData ?? 'shallow';
  return {
    id: 'task-state' as const,
    name: 'Task State',
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
    provides: {
      recordArtifact: layerFunction<
        {
          path: string;
        },
        string,
        DurableTaskState
      >({
        description:
          'Record a file this task produced or modified. Recorded paths survive the task boundary and merge back into the parent task.',
        input: z.object({
          path: z.string().min(1),
        }),
        output: z.string(),
        execute: async (args, state) => {
          if (state.files.includes(args.path)) {
            return {
              result: `Already recorded: ${args.path}`,
              state,
            };
          }
          return {
            result: `Recorded artifact: ${args.path}`,
            state: {
              ...state,
              files: [
                ...state.files,
                args.path,
              ],
            },
          };
        },
      }),

      setTaskData: layerFunction<
        {
          key: string;
          value: unknown;
        },
        string,
        DurableTaskState
      >({
        description:
          'Record a structured result for this task under a key (e.g. a PR url, a verdict, a summary). Values survive the task boundary and merge back into the parent task.',
        input: z.object({
          key: z.string().min(1),
          value: z.unknown(),
        }),
        output: z.string(),
        execute: async (args, state) => {
          // `__outcome` is written by onComplete; letting the model set it would
          // make the recorded outcome unreliable.
          if (args.key === '__outcome') {
            return {
              result: 'Cannot set reserved key "__outcome".',
              state,
            };
          }
          return {
            result: `Recorded ${args.key}.`,
            state: {
              ...state,
              data: {
                ...state.data,
                [args.key]: args.value,
              },
            },
          };
        },
      }),
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
        // `budget > 0` is the fail-open convention (see instructions): a zero
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

      async onReturn({ childState, parentState, childCtx }) {
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
            data: mergeChildData({
              parent,
              childState,
              childExecutionId: childCtx.executionId,
              mergeData,
            }),
          },
        };
      },

      async onComplete({ state, outcome, ctx }) {
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
                // The completing execution's own depth — a hardcoded 0 made
                // every terminal checkpoint look root-level regardless of
                // where the execution actually sat in the spawn tree.
                depth: ctx.depth,
              },
            ]),
          },
        };
      },
    },
  } satisfies ContextLayer<DurableTaskState>;
}
