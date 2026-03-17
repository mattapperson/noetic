import type { Step } from '@noetic/core';
import { InMemoryExporter, InMemoryRuntime, spawn } from '@noetic/core';

import type { EvalSuiteConfig } from '../types/eval';
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

export function createEvalContext(
  config: EvalSuiteConfig,
  objective: string,
  background: string,
): EvalContext {
  return {
    objective,
    background,
    async execute(input: unknown): Promise<EvalExecution> {
      const exporter = new InMemoryExporter();
      const runtime = new InMemoryRuntime({
        callModel: config.callModel,
        traceExporter: exporter,
      });

      const targetStep: Step = config.memory?.length
        ? spawn({
            id: 'eval-memory-wrapper',
            child: config.step,
            memory: config.memory,
          })
        : config.step;

      const ctx = runtime.createContext();
      const output = await runtime.execute(targetStep, input, ctx);
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
