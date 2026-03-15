import type { MemoryLayer } from '../../types/memory';
import type { MessageItem } from '../../types/items';
import { Slot } from '../../types/memory';
import { isOutputText } from '../../interpreter/typeguards';

export interface ObservationalState {
  observations: string[];
  buffer: string[];
  version: number;
}

export interface ObservationalMemoryConfig {
  bufferThreshold?: number;
  maxObservations?: number;
  scope?: 'thread' | 'resource';
}

export function observationalMemory(config?: ObservationalMemoryConfig): MemoryLayer<ObservationalState> {
  const maxObs = config?.maxObservations ?? 20;
  const threshold = config?.bufferThreshold ?? 5;

  return {
    id: 'observational-memory',
    name: 'Observational Memory',
    slot: Slot.OBSERVATIONS,
    scope: config?.scope ?? 'resource',
    budget: { min: 500, max: 2500 },
    timeouts: { store: 60_000 },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<ObservationalState>('state');
        return { state: saved ?? { observations: [], buffer: [], version: 0 } };
      },

      async recall({ state }) {
        if (!state?.observations?.length) return null;
        const bullets = state.observations.map((o: string) => `- ${o}`).join('\n');
        const text = `<observations>\n${bullets}\n</observations>`;
        const item: MessageItem = {
          id: crypto.randomUUID(),
          status: 'completed',
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text }],
        };
        return { items: [item], tokenCount: Math.ceil(text.length / 4) };
      },

      async store({ newItems, state }) {
        const s: ObservationalState = state ?? { observations: [], buffer: [], version: 0 };
        // Accumulate new items into buffer
        const textItems = newItems
          .filter((i): i is MessageItem => i.type === 'message')
          .map(i => i.content.filter(isOutputText).map(c => c.text).join(''))
          .filter(t => t.length > 0);

        const newBuffer = [...s.buffer, ...textItems];

        // If buffer exceeds threshold, compress into observation
        if (newBuffer.length >= threshold) {
          const observation = `Processed ${newBuffer.length} items`;
          const newObservations = [...s.observations, observation].slice(-maxObs);
          return { state: { observations: newObservations, buffer: [], version: s.version + 1 } };
        }

        return { state: { ...s, buffer: newBuffer } };
      },

      async onSpawn({ parentState }) {
        return { childState: structuredClone(parentState) };
      },
    },
  };
}
