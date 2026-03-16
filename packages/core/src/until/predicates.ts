import { cosineSimilarity } from '../conditions/cosine-similarity';
import type { EmbedFn } from '../types/embed';
import type { StorageAdapter } from '../types/memory';
import type { Snapshot, Until, Verdict } from '../types/step';

export type VerifyFn = (output: unknown) => Promise<{
  pass: boolean;
  feedback?: string;
}>;
export interface ConvergeOpts {
  /** Similarity threshold. Default 1 (exact match). When embed is provided and threshold < 1, uses cosine similarity. */
  threshold?: number;
  /** When provided with threshold < 1, enables embedding-based similarity comparison. */
  embed?: EmbedFn;
  /** Persist previous output vector across ephemeral invocations. */
  cache?: StorageAdapter;
}

const CONVERGE_CACHE_KEY = 'converge:previousVector';

export const until = {
  maxSteps(n: number): Until {
    return (snap: Snapshot): Verdict => ({
      stop: snap.stepCount >= n,
      reason: snap.stepCount >= n ? `Reached max steps (${n})` : undefined,
    });
  },

  maxCost(usd: number): Until {
    return (snap: Snapshot): Verdict => ({
      stop: snap.cost >= usd,
      reason: snap.cost >= usd ? `Reached max cost ($${usd})` : undefined,
    });
  },

  maxDuration(ms: number): Until {
    return (snap: Snapshot): Verdict => ({
      stop: snap.elapsed >= ms,
      reason: snap.elapsed >= ms ? `Reached max duration (${ms}ms)` : undefined,
    });
  },

  noToolCalls(): Until {
    return (snap: Snapshot): Verdict => {
      if (snap.stepCount < 1) {
        return {
          stop: false,
        };
      }
      const meta = snap.lastStepMeta;
      const hasToolCalls = meta?.toolCalls && meta.toolCalls.length > 0;
      return {
        stop: !hasToolCalls,
        reason: !hasToolCalls ? 'No tool calls in last response' : undefined,
      };
    };
  },

  verified(fn: VerifyFn): Until {
    return async (snap: Snapshot): Promise<Verdict> => {
      const result = await fn(snap.lastOutput);
      return {
        stop: result.pass,
        reason: result.pass ? 'Verification passed' : undefined,
        feedback: result.feedback,
      };
    };
  },

  converged(opts: ConvergeOpts): Until {
    const threshold = opts.threshold ?? 1;
    const { embed } = opts;

    if (!embed || threshold >= 1) {
      // Exact string equality (original behavior)
      let previousOutput: string | null = null;
      return (snap: Snapshot): Verdict => {
        const currentText = snap.lastText;
        if (previousOutput === null) {
          previousOutput = currentText;
          return {
            stop: false,
          };
        }
        const similar = currentText === previousOutput;
        previousOutput = currentText;
        return {
          stop: similar,
          reason: similar ? 'Output converged' : undefined,
        };
      };
    }

    // Embedding-based similarity — embed is narrowed to EmbedFn here
    let previousVector: readonly number[] | null = null;

    const persistVector = async (vector: readonly number[]): Promise<void> => {
      if (opts.cache) {
        await opts.cache.set(CONVERGE_CACHE_KEY, vector);
      }
      previousVector = vector;
    };

    return async (snap: Snapshot): Promise<Verdict> => {
      const currentText = snap.lastText;
      const [currentVector] = await embed([
        currentText,
      ]);

      // Try to load previous vector from cache if we don't have one in closure
      if (!previousVector && opts.cache) {
        previousVector = await opts.cache.get<number[]>(CONVERGE_CACHE_KEY);
      }

      if (!previousVector) {
        await persistVector(currentVector);
        return {
          stop: false,
        };
      }

      const similarity = cosineSimilarity(currentVector, previousVector);
      await persistVector(currentVector);

      const converged = similarity >= threshold;
      return {
        stop: converged,
        reason: converged ? `Output converged (similarity: ${similarity.toFixed(3)})` : undefined,
      };
    };
  },

  outputContains(marker: string): Until {
    return (snap: Snapshot): Verdict => ({
      stop: snap.lastText.includes(marker),
      reason: snap.lastText.includes(marker) ? `Output contains marker: ${marker}` : undefined,
    });
  },

  custom(fn: Until): Until {
    return fn;
  },
};
