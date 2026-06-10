import type { MemoryLayer, MemoryScope } from '@noetic-tools/types';
import { createMessage, estimateTokens, Slot } from '@noetic-tools/types';
import type { ZodType } from 'zod';
import { z } from 'zod';
import { findFunctionCall } from '../function-call-utils';
import { layerData, layerFn } from '../layer-provides';

export type WorkingMemoryState = string | Record<string, unknown>;

export interface WorkingMemoryConfig {
  scope?: 'thread' | 'resource';
  schema?: ZodType;
  template?: string;
  readOnly?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Cap recursion depth so a cyclic or pathologically-nested update can't overflow the stack. */
const MAX_MERGE_DEPTH = 32;

/**
 * Recursively merges `source` into `target`: object-valued keys are deep-merged,
 * while arrays and primitives replace. Prototype-pollution keys (`__proto__`,
 * `constructor`) are stripped at every depth. Beyond `MAX_MERGE_DEPTH` the source
 * value replaces rather than recurses (cycle/over-nesting guard).
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...target,
  };
  for (const [key, value] of Object.entries(source)) {
    if (key === '__proto__' || key === 'constructor') {
      continue;
    }
    const existing = out[key];
    if (isPlainObject(value) && depth < MAX_MERGE_DEPTH) {
      out[key] = isPlainObject(existing)
        ? deepMerge(existing, value, depth + 1)
        : deepMerge({}, value, depth + 1);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Validate a MERGED working-memory state against the configured schema (a
 * pure gate — the original value is returned, transforms are not applied).
 * Validating the merged state (not the raw update) keeps partial updates
 * legal under schemas with required fields. Throws on failure so the update
 * is rejected and the prior state stays untouched.
 */
function applySchema(schema: ZodType | undefined, merged: WorkingMemoryState): WorkingMemoryState {
  if (!schema) {
    return merged;
  }
  const result = schema.safeParse(merged);
  if (!result.success) {
    throw new Error(`working-memory update rejected by schema: ${result.error.message}`);
  }
  return merged;
}

function safeMerge(state: WorkingMemoryState, args: Record<string, unknown>): WorkingMemoryState {
  if (typeof state === 'object' && state !== null) {
    return deepMerge(state, args);
  }
  // Freeform string state: an object update must not silently discard prior content.
  const merged = deepMerge({}, args);
  if (typeof state === 'string' && state.length > 0) {
    // `_previous` last so the preserved prior content always wins over a
    // (pathological) update key literally named `_previous`.
    return {
      ...merged,
      _previous: state,
    };
  }
  return merged;
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
        // Validation failure throws → surfaces as a tool error the model can
        // see; the prior state is untouched.
        execute: async (args, state) => ({
          result: undefined,
          state: applySchema(config?.schema, safeMerge(state, args)),
        }),
      }),
    },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<WorkingMemoryState>('state');
        // Corrupt persisted state (fails the configured schema) falls back to
        // the default rather than aborting the execution.
        if (saved !== null && config?.schema && !config.schema.safeParse(saved).success) {
          return {
            state: {},
          };
        }
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
        // Backward compat: detect implicit updateWorkingMemory calls from LLMs.
        // Schema-violating merges throw — storeLayers catches, reports a
        // diagnostic, and drops the update (prior state preserved).
        const args = findFunctionCall(newItems, 'updateWorkingMemory');
        if (!args) {
          return;
        }
        return {
          state: applySchema(config?.schema, safeMerge(state, args)),
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
