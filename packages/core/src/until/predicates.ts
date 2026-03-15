import type { Until, Snapshot, Verdict } from '../types/step';

export type VerifyFn = (output: unknown) => Promise<{ pass: boolean; feedback?: string }>;
export interface ConvergeOpts {
  threshold: number;
}

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
      if (snap.stepCount < 1) return { stop: false };
      const meta = (snap as any).lastStepMeta;
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
    let previousOutput: string | null = null;
    return (snap: Snapshot): Verdict => {
      const currentText = snap.lastText;
      if (previousOutput === null) {
        previousOutput = currentText;
        return { stop: false };
      }
      const similar = currentText === previousOutput;
      previousOutput = currentText;
      return {
        stop: similar,
        reason: similar ? 'Output converged' : undefined,
      };
    };
  },

  outputContains(marker: string): Until {
    return (snap: Snapshot): Verdict => ({
      stop: snap.lastText.includes(marker),
      reason: snap.lastText.includes(marker)
        ? `Output contains marker: ${marker}`
        : undefined,
    });
  },

  custom(fn: Until): Until {
    return fn;
  },
};
