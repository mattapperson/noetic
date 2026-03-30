import type { Tool, ToolMemoryDeclaration } from '../../types/common';
import type { MemoryLayer, MemoryScope } from '../../types/memory';
import { Slot } from '../../types/memory';

interface ToolMemoryLayerOpts {
  slot?: number;
}

const EXECUTION_SCOPE: MemoryScope = 'execution';

/**
 * Generates one MemoryLayer per unique memory id among the provided tools.
 * Tools sharing the same `memory.id` share a single layer (and thus state).
 *
 * @public
 * @param tools - Array of tools to extract memory declarations from.
 * @param opts - Optional slot override for the generated layers.
 * @returns An array of `MemoryLayer` instances, one per unique tool memory id.
 */
export function toolMemoryLayer(
  tools: ReadonlyArray<Tool>,
  opts?: ToolMemoryLayerOpts,
): MemoryLayer[] {
  const seen = new Map<string, ToolMemoryDeclaration>();

  for (const t of tools) {
    if (!t.memory) {
      continue;
    }
    const memId = t.memory.id ?? t.name;
    if (seen.has(memId)) {
      continue;
    }
    seen.set(memId, t.memory);
  }

  const slot = opts?.slot ?? Slot.WORKING_MEMORY + 10;

  return [
    ...seen.entries(),
  ].map(([memId, decl]) => ({
    id: memId,
    name: memId,
    slot,
    scope: EXECUTION_SCOPE,
    hooks: {
      async init() {
        return {
          state: decl.init(),
        };
      },

      async recall({ state }: { state: unknown }) {
        return decl.recall(state);
      },
    },
  }));
}
