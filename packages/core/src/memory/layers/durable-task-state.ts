import type { MemoryLayer } from '../../types/memory';
import type { MessageItem } from '../../types/items';
import { Slot } from '../../types/memory';

export interface DurableTaskStateConfig {
  schema?: any;
}

export function durableTaskState(config?: DurableTaskStateConfig): MemoryLayer {
  return {
    id: 'durable-task-state',
    name: 'Durable Task State',
    slot: Slot.WORKING_MEMORY + 10, // 110
    scope: 'execution',
    budget: { min: 100, max: 800 },
    timeouts: { store: 30_000 },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<unknown>('state');
        return { state: saved ?? { checkpoints: [], files: [], data: {} } };
      },

      async recall({ state }) {
        if (!state) return null;
        const text = `<task_state>\n${JSON.stringify(state, null, 2)}\n</task_state>`;
        const item: MessageItem = {
          id: crypto.randomUUID(),
          status: 'completed',
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text }],
        };
        return { items: [item], tokenCount: Math.ceil(text.length / 4) };
      },

      async store({ state, ctx }) {
        const currentState = (state as any) ?? { checkpoints: [], files: [], data: {} };
        // Add a checkpoint for each store call
        const newState = {
          ...currentState,
          checkpoints: [...(currentState.checkpoints ?? []), { timestamp: Date.now(), depth: ctx.depth }],
        };
        return { state: newState };
      },

      async onSpawn({ parentState }) {
        // ALWAYS provides child state (unlike other layers)
        return { childState: structuredClone(parentState), items: [] };
      },

      async onReturn({ childState, parentState }) {
        // Merge child artifacts back to parent
        const parent = parentState as any;
        const child = childState as any;
        return {
          parentState: {
            ...parent,
            checkpoints: [...(parent.checkpoints ?? []), ...(child.checkpoints ?? [])],
            files: [...new Set([...(parent.files ?? []), ...(child.files ?? [])])],
            data: { ...parent.data, ...child.data },
          },
        };
      },

},
  };
}
