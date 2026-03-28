import type { Step } from '@noetic/core';
import { InMemoryAgentHarness, InMemoryExporter } from '@noetic/core';

import type { EvalSuiteOptions } from '../types/eval';
import type { EvalExecution, ScoreResult, ScorerFn } from './eval-execution';

//#region Types

export interface EvalContext {
  execute(input: unknown): Promise<EvalExecution>;
  objective: string;
  background: string;
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

export function createEvalContext(step: Step, options: EvalSuiteOptions): EvalContext {
  const objective = options.objective;
  const background = options.background ?? '';

  return {
    objective,
    background,
    async execute(input: unknown): Promise<EvalExecution> {
      const exporter = new InMemoryExporter();
      const harness = new InMemoryAgentHarness({
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
          return runScorers({
            scorers,
            execution,
            objective,
            background,
          });
        },
      };

      return execution;
    },
  };
}

//#endregion
