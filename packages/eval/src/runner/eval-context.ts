import type { LlmProviderConfig, Step } from '@noetic-tools/core';
import { AgentHarness, InMemoryExporter } from '@noetic-tools/core';

import type { EvalSuiteOptions, ScoreResult } from '../types/eval';
import type { EvalExecution, ScorerFn } from './eval-execution';

//#region Types

export interface EvalContext {
  execute(input: unknown): Promise<EvalExecution>;
  objective: string;
  background: string;
}

/** Internal extension used only by the suite runner to read accumulated scores. */
export interface EvalContextInternal extends EvalContext {
  readonly accumulatedScores: ReadonlyArray<ScoreResult>;
}

//#endregion

//#region Helper Functions

interface RunScorersOpts {
  scorers: ScorerFn[];
  execution: EvalExecution;
  objective: string;
  background: string;
}

/**
 * Defense in depth: every ScoreResult that reaches case scores, suite
 * aggregates, and baselines is finite and within [0, 1] — including results
 * from builtin scorers that bypass the createScorer pipeline. Sanitized
 * results carry the original value in `metadata.sanitizedFrom`.
 */
function sanitizeScoreResult(result: ScoreResult): ScoreResult {
  const raw = result.score;
  if (Number.isFinite(raw) && raw >= 0 && raw <= 1) {
    return result;
  }
  const sanitized = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
  return {
    ...result,
    score: sanitized,
    metadata: {
      ...result.metadata,
      sanitizedFrom: raw,
    },
  };
}

/**
 * Resolve the harness LLM provider from the environment. A Noetic platform key
 * wins (matching the harness default of `provider: 'noetic'`); otherwise fall
 * back to direct OpenRouter so suites gated on `OPENROUTER_API_KEY` can run.
 * The key itself is never copied into config — the harness reads it from the
 * environment for the selected provider.
 */
function resolveEnvLlm(): LlmProviderConfig | undefined {
  if (process.env.NOETIC_API_KEY) {
    return undefined;
  }
  if (process.env.OPENROUTER_API_KEY) {
    return {
      provider: 'openrouter',
    };
  }
  return undefined;
}

async function runScorers(opts: RunScorersOpts): Promise<ScoreResult[]> {
  const results = await Promise.all(
    opts.scorers.map((scorer) => scorer(opts.execution, opts.objective, opts.background)),
  );
  return results.map(sanitizeScoreResult);
}

//#endregion

//#region Public API

export function createEvalContext(step: Step, options: EvalSuiteOptions): EvalContextInternal {
  const objective = options.objective;
  const background = options.background ?? '';

  const scores: ScoreResult[] = [];

  return {
    objective,
    background,
    get accumulatedScores(): ReadonlyArray<ScoreResult> {
      return scores;
    },
    async execute(input: unknown): Promise<EvalExecution> {
      const exporter = new InMemoryExporter();
      const harness = new AgentHarness({
        name: 'eval',
        params: {},
        traceExporter: exporter,
        callModelDefaults: resolveEnvLlm(),
      });

      const ctx = harness.createContext();
      const output = await harness.run(step, input, ctx);
      const traces = [
        ...exporter.spans,
      ];

      const execution: EvalExecution = {
        output,
        context: ctx,
        traces,
        async score(scorers: ScorerFn[]): Promise<ScoreResult[]> {
          const results = await runScorers({
            scorers,
            execution,
            objective,
            background,
          });
          scores.push(...results);
          return results;
        },
      };

      return execution;
    },
  };
}

//#endregion
