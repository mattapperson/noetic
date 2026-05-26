import type { Step } from '@noetic-tools/core';
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

async function runScorers(opts: RunScorersOpts): Promise<ScoreResult[]> {
  return Promise.all(
    opts.scorers.map((scorer) => scorer(opts.execution, opts.objective, opts.background)),
  );
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
