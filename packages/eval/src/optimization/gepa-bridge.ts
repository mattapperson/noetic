import type { Step } from '@noetic/core';

import type { Candidate, OptimizableField, OptimizationResult } from '../types/optimizer';
import { applyCandidate } from './mutator';

//#region Types

interface OptimizeParams {
  step: Step;
  fields: OptimizableField[];
  runEval: (step: Step) => Promise<Record<string, number>>;
  examples?: unknown[];
  maxMetricCalls?: number;
}

//#endregion

//#region Helper Functions

function buildInitialCandidate(fields: OptimizableField[]): Candidate {
  const candidate: Candidate = {};
  for (const field of fields) {
    candidate[field.path] = field.value;
  }
  return candidate;
}

function averageScore(scores: Record<string, number>): number {
  const values = Object.values(scores);
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

//#endregion

//#region Public API

export async function optimizeWithGepa(params: OptimizeParams): Promise<OptimizationResult> {
  const initialCandidate = buildInitialCandidate(params.fields);

  const metricFn = async (candidateValues: Candidate): Promise<Record<string, number>> => {
    const candidateStep = applyCandidate(params.step, candidateValues);
    return params.runEval(candidateStep);
  };

  // Placeholder: evaluate once. When AxGEPA is wired in, this becomes
  // a proper optimization loop that mutates candidates between iterations.
  const scores = await metricFn(initialCandidate);
  const bestScore = averageScore(scores);

  return {
    bestCandidate: initialCandidate,
    score: bestScore,
    iterations: 1,
  };
}

//#endregion
