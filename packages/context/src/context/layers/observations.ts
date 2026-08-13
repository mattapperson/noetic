import type { ContextLayer, ExecutionContext } from '@noetic-tools/types';
import {
  collectInputText,
  collectOutputText,
  createMessage,
  estimateTokens,
  Slot,
} from '@noetic-tools/types';
import { resolveScopeKey } from '../scope';

export interface ObservationsState {
  observations: string[];
  buffer: string[];
  bufferTokens: number;
  version: number;
}

const DEFAULT_BUFFER_THRESHOLD_TOKENS = 2_000;
const DEFAULT_MAX_OBSERVATIONS = 50;

export type ObserverFn = (buffer: string[]) => Promise<string[]>;

function emptyObservationsState(): ObservationsState {
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
  /** Background-distillation bucket for the current scope key. */
  deferred: DeferredDistill;
}

/**
 * In-flight background distillations for one scope key. Results drain into
 * state on the next `store` / `onItemAppend` — distillation is eventually
 * visible, never turn-blocking. An LLM-backed observer used to add its full
 * round-trip latency to the user's turn (both hooks awaited it, with 60s
 * timeouts); now the turn pays only the buffer append.
 *
 * Keyed per scope key rather than per layer instance: one layer instance is
 * shared across every thread/resource on a harness, while its state is stored
 * per scope, so a single shared bucket would drain resource A's distillation
 * into resource B's observations.
 */
interface DeferredBatch {
  buffer: string[];
  result?: string[];
  failed?: boolean;
}

interface DeferredDistill {
  /** Dispatch-ordered batches. Only the settled prefix drains into state. */
  batches: DeferredBatch[];
}

/**
 * Folds completed background batches into `observations` and re-buffers failed
 * ones (the previous blocking path kept the buffer on observer failure; the
 * deferred path preserves that no-loss behavior). Returns `s` unchanged
 * (identity-comparable) when nothing has completed.
 */
function drainDeferred(
  s: ObservationsState,
  d: DeferredDistill,
  maxObs: number,
): ObservationsState {
  const settled: DeferredBatch[] = [];
  while (d.batches[0]?.result !== undefined || d.batches[0]?.failed) {
    const batch = d.batches.shift();
    if (batch) {
      settled.push(batch);
    }
  }
  if (settled.length === 0) {
    return s;
  }
  const retries = settled.filter((batch) => batch.failed).flatMap((batch) => batch.buffer);
  const observations = settled.flatMap((batch) => batch.result ?? []);
  const buffer =
    retries.length > 0
      ? [
          ...retries,
          ...s.buffer,
        ]
      : s.buffer;
  return {
    observations: [
      ...s.observations,
      ...observations,
    ].slice(-maxObs),
    buffer,
    bufferTokens: buffer.reduce((sum, t) => sum + estimateTokens(t), 0),
    version: s.version + 1,
  };
}

/**
 * Appends `texts` into the layer buffer and, once the token threshold is crossed,
 * distills the buffer into observations. Shared by `store` (assistant output) and
 * `onItemAppend` (user/tool input).
 */
function accumulate(
  s: ObservationsState,
  texts: string[],
  cfg: AccumulateConfig,
): ObservationsState {
  const deferred = cfg.deferred;
  const withReady = drainDeferred(s, deferred, cfg.maxObs);
  const newBuffer = [
    ...withReady.buffer,
    ...texts,
  ];
  const newTokens = texts.reduce((sum, t) => sum + estimateTokens(t), 0);
  const totalBufferTokens = withReady.bufferTokens + newTokens;
  if (totalBufferTokens >= cfg.threshold) {
    if (cfg.observer) {
      // Fire-and-collect: the observer runs off the turn path; its result
      // joins `ready` (or its buffer joins `failed` on rejection) and drains
      // into state on a later hook. Both handlers resolve, so the derived
      // promise can never be an unhandled rejection.
      const batch: DeferredBatch = {
        buffer: newBuffer,
      };
      deferred.batches.push(batch);
      void Promise.resolve()
        .then(() => cfg.observer?.(newBuffer))
        .then(
          (distilled) => {
            batch.result = distilled ?? [];
          },
          () => {
            batch.failed = true;
          },
        );
      return {
        ...withReady,
        buffer: [],
        bufferTokens: 0,
      };
    }
    return {
      observations: [
        ...withReady.observations,
        `Processed ${newBuffer.length} items`,
      ].slice(-cfg.maxObs),
      buffer: [],
      bufferTokens: 0,
      version: withReady.version + 1,
    };
  }
  return {
    ...withReady,
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

export interface ObservationsConfig {
  bufferThreshold?: number;
  maxObservations?: number;
  scope?: 'thread' | 'resource';
  observer?: ObserverFn;
}

/**
 * Creates a context layer that buffers raw items and distills them into observations when a token threshold is reached.
 *
 * @public
 * @param config - Optional configuration for buffer threshold, max observations, scope, and observer function.
 * @returns A `ContextLayer` that accumulates and summarizes observations over time.
 */
export function observations(config?: ObservationsConfig) {
  const maxObs = config?.maxObservations ?? DEFAULT_MAX_OBSERVATIONS;
  const threshold = config?.bufferThreshold ?? DEFAULT_BUFFER_THRESHOLD_TOKENS;
  const observer = config?.observer;
  const scope = config?.scope ?? 'resource';
  // One bucket per scope key: this layer instance is shared across every
  // thread/resource on a harness, but its state is stored per scope.
  const deferredByScope = new Map<string, DeferredDistill>();
  const deferredFor = (ctx: ExecutionContext): DeferredDistill => {
    const key = resolveScopeKey(scope, ctx);
    let bucket = deferredByScope.get(key);
    if (!bucket) {
      bucket = {
        batches: [],
      };
      deferredByScope.set(key, bucket);
    }
    return bucket;
  };

  return {
    id: 'observations' as const,
    name: 'Observations',
    slot: Slot.OBSERVATIONS,
    scope,
    budget: {
      min: 500,
      max: 2_500,
    },
    // No LLM in the hook path any more — distillation is deferred, so no
    // `timeouts` override: the default hook timeouts are ample.
    hooks: {
      async init({ storage }) {
        const saved = await storage.get<ObservationsState>('state');
        return {
          state: saved ?? emptyObservationsState(),
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

      // Captures assistant output text. Also the drain point for background
      // distillations: `store` runs every turn and its returned state is always
      // persisted, so a completed batch lands without `recall` mutating state
      // (which would force this layer out of the anchor band for that turn).
      async store({ newItems, state, ctx }) {
        const s = state ?? emptyObservationsState();
        const texts = collectOutputText(newItems);
        return {
          state: accumulate(s, texts, {
            threshold,
            maxObs,
            observer,
            deferred: deferredFor(ctx),
          }),
        };
      },

      // Captures user input and tool output text (pass-through; no transform).
      async onItemAppend({ items, state, ctx }) {
        const s = state ?? emptyObservationsState();
        const texts = collectInputText(items);
        const deferred = deferredFor(ctx);
        if (texts.length === 0) {
          // Still fold in anything that finished, so a quiet append is not a
          // missed drain opportunity.
          const drained = drainDeferred(s, deferred, maxObs);
          return drained === s
            ? {
                items,
              }
            : {
                items,
                state: drained,
              };
        }
        return {
          items,
          state: accumulate(s, texts, {
            threshold,
            maxObs,
            observer,
            deferred,
          }),
        };
      },

      async onSpawn({ parentState }) {
        return {
          childState: structuredClone(parentState),
        };
      },
    },
  } satisfies ContextLayer<ObservationsState>;
}
