import type { MemoryLayer } from '@noetic-tools/types';
import {
  collectInputText,
  collectOutputText,
  createMessage,
  estimateTokens,
  Slot,
} from '@noetic-tools/types';

export interface ObservationalState {
  observations: string[];
  buffer: string[];
  bufferTokens: number;
  version: number;
}

const DEFAULT_BUFFER_THRESHOLD_TOKENS = 2_000;
const DEFAULT_MAX_OBSERVATIONS = 50;

export type ObserverFn = (buffer: string[]) => Promise<string[]>;

function emptyObservationalState(): ObservationalState {
  return {
    observations: [],
    buffer: [],
    bufferTokens: 0,
    version: 0,
  };
}

interface AccumulateConfig {
  threshold: number;
  maxObs: number;
  observer?: ObserverFn;
}

/**
 * Appends `texts` into the layer buffer and, once the token threshold is crossed,
 * distills the buffer into observations. Shared by `store` (assistant output) and
 * `onItemAppend` (user/tool input).
 */
async function accumulate(
  s: ObservationalState,
  texts: string[],
  cfg: AccumulateConfig,
): Promise<ObservationalState> {
  const newBuffer = [
    ...s.buffer,
    ...texts,
  ];
  const newTokens = texts.reduce((sum, t) => sum + estimateTokens(t), 0);
  const totalBufferTokens = s.bufferTokens + newTokens;
  if (totalBufferTokens >= cfg.threshold) {
    const distilled = cfg.observer
      ? await cfg.observer(newBuffer)
      : [
          `Processed ${newBuffer.length} items`,
        ];
    const newObservations = [
      ...s.observations,
      ...distilled,
    ].slice(-cfg.maxObs);
    return {
      observations: newObservations,
      buffer: [],
      bufferTokens: 0,
      version: s.version + 1,
    };
  }
  return {
    ...s,
    buffer: newBuffer,
    bufferTokens: totalBufferTokens,
  };
}

/** Render observations as a tagged bullet list. */
function renderObservations(observations: ReadonlyArray<string>): string {
  const bullets = observations.map((o) => `- ${o}`).join('\n');
  return `<observations>\n${bullets}\n</observations>`;
}

/**
 * Render the most recent observations that fit within `budget` tokens (rendered
 * output included). Drops oldest observations first; returns null if not even
 * the single newest observation fits.
 */
function renderObservationsWithinBudget(
  observations: ReadonlyArray<string>,
  budget: number,
): string | null {
  for (let start = 0; start < observations.length; start++) {
    const text = renderObservations(observations.slice(start));
    if (estimateTokens(text) <= budget) {
      return text;
    }
  }
  return null;
}

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
      // onItemAppend runs the same LLM-backed accumulate/distill path as
      // store — it needs the same headroom, not the 5s pipeline default.
      onItemAppend: 60_000,
    },
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<ObservationalState>('state');
        return {
          state: saved ?? emptyObservationalState(),
        };
      },

      async recall({ state, budget }) {
        if (!state?.observations?.length) {
          return null;
        }
        // Trim to the most recent observations that fit within the token budget.
        const text = renderObservationsWithinBudget(state.observations, budget);
        if (text === null) {
          return null;
        }
        return {
          items: [
            createMessage(text, 'developer'),
          ],
          tokenCount: estimateTokens(text),
        };
      },

      // Captures assistant output text.
      async store({ newItems, state }) {
        const s = state ?? emptyObservationalState();
        const texts = collectOutputText(newItems);
        return {
          state: await accumulate(s, texts, {
            threshold,
            maxObs,
            observer,
          }),
        };
      },

      // Captures user input and tool output text (pass-through; no transform).
      async onItemAppend({ items, state }) {
        const s = state ?? emptyObservationalState();
        const texts = collectInputText(items);
        if (texts.length === 0) {
          return {
            items,
          };
        }
        return {
          items,
          state: await accumulate(s, texts, {
            threshold,
            maxObs,
            observer,
          }),
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
