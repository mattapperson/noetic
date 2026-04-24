import { createMessage, estimateTokens } from '../../interpreter/message-helpers';
import { isOutputText } from '../../interpreter/typeguards';
import type { MessageItem } from '../../types/items';
import type { MemoryLayer } from '../../types/memory';
import { Slot } from '../../types/memory';

export interface ObservationalState {
  observations: string[];
  buffer: string[];
  bufferTokens: number;
  version: number;
}

const DEFAULT_BUFFER_THRESHOLD_TOKENS = 2_000;
const DEFAULT_MAX_OBSERVATIONS = 50;

export type ObserverFn = (buffer: string[]) => Promise<string[]>;

export interface ObservationalMemoryConfig {
  bufferThreshold?: number;
  maxObservations?: number;
  scope?: 'thread' | 'resource';
  observer?: ObserverFn;
}

/**
 * Creates a memory layer that buffers raw items and distills them into observations when a token threshold is reached.
 *
 * @public
 * @param config - Optional configuration for buffer threshold, max observations, scope, and observer function.
 * @returns A `MemoryLayer` that accumulates and summarizes observations over time.
 */
export function observationalMemory(config?: ObservationalMemoryConfig) {
  const maxObs = config?.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
  const threshold = config?.bufferThreshold ?? DEFAULT_BUFFER_THRESHOLD_TOKENS;
  const observer = config?.observer;

  return {
    id: 'observational-memory' as const,
    name: 'Observational Memory',
    slot: Slot.OBSERVATIONS,
    scope: config?.scope ?? 'resource',
    budget: {
      min: 500,
      max: 2_500,
    },
    timeouts: {
      store: 60_000,
    },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<ObservationalState>('state');
        return {
          state: saved ?? {
            observations: [],
            buffer: [],
            bufferTokens: 0,
            version: 0,
          },
        };
      },

      async recall({ state }) {
        if (!state?.observations?.length) {
          return null;
        }
        const bullets = state.observations.map((o: string) => `- ${o}`).join('\n');
        const text = `<observations>\n${bullets}\n</observations>`;
        return {
          items: [
            createMessage(text, 'developer'),
          ],
          tokenCount: estimateTokens(text),
        };
      },

      async store({ newItems, state }) {
        const s: ObservationalState = state ?? {
          observations: [],
          buffer: [],
          bufferTokens: 0,
          version: 0,
        };
        // Accumulate new items into buffer
        const textItems = newItems
          .filter((i): i is MessageItem => i.type === 'message')
          .map((i) =>
            i.content
              .filter(isOutputText)
              .map((c: { text: string }) => c.text)
              .join(''),
          )
          .filter((t) => t.length > 0);

        const newBuffer = [
          ...s.buffer,
          ...textItems,
        ];

        // Token-based threshold: accumulate incrementally
        const newTokens = textItems.reduce((sum, t) => sum + estimateTokens(t), 0);
        const totalBufferTokens = s.bufferTokens + newTokens;
        if (totalBufferTokens >= threshold) {
          const distilled = observer
            ? await observer(newBuffer)
            : [
                `Processed ${newBuffer.length} items`,
              ];
          const newObservations = [
            ...s.observations,
            ...distilled,
          ].slice(-maxObs);
          return {
            state: {
              observations: newObservations,
              buffer: [],
              bufferTokens: 0,
              version: s.version + 1,
            },
          };
        }

        return {
          state: {
            ...s,
            buffer: newBuffer,
            bufferTokens: totalBufferTokens,
          },
        };
      },

      async onSpawn({ parentState }) {
        return {
          childState: structuredClone(parentState),
        };
      },
    },
  } satisfies MemoryLayer<ObservationalState>;
}
