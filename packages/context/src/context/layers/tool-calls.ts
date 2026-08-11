import type { ContextLayer, ContextScope, Tool, ToolContextDeclaration } from '@noetic-tools/types';
import { Slot } from '@noetic-tools/types';

interface ToolCallsOptions {
  slot?: number;
}

const EXECUTION_SCOPE: ContextScope = 'execution';

/**
 * Generates one ContextLayer per unique context id among the provided tools.
 * Tools sharing the same `context.id` share a single layer (and thus state).
 *
 * @public
 * @param tools - Array of tools to extract context declarations from.
 * @param opts - Optional slot override for the generated layers.
 * @returns An array of `ContextLayer` instances, one per unique tool context id.
 */
export function toolCalls(tools: ReadonlyArray<Tool>, opts?: ToolCallsOptions): ContextLayer[] {
  const seen = new Map<string, ToolContextDeclaration>();

  for (const t of tools) {
    if (!t.context) {
      continue;
    }
    const layerId = t.context.id ?? t.name;
    if (seen.has(layerId)) {
      continue;
    }
    seen.set(layerId, t.context);
  }

  const slot = opts?.slot ?? Slot.WORKING_MEMORY + 10;

  return [
    ...seen.entries(),
  ].map(([layerId, decl]) => ({
    id: layerId,
    name: layerId,
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
