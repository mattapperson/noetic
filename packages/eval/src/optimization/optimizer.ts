import type { Step } from '@noetic/core';

import type { OptimizeConfig } from '../types/eval';
import type { Candidate, CodingAgent, OptimizableField } from '../types/optimizer';
import type { SourceLocation } from '../types/source-location';
import { discoverFields } from './field-discovery';
import { optimizeWithGepa } from './gepa-bridge';
import type { WriteBackEntry } from './source-writer';
import { writeOptimizedValues } from './source-writer';

//#region Types

export interface OptimizeOptions {
  step: Step;
  scope: OptimizeConfig['scope'];
  runEval: (step: Step) => Promise<Record<string, number>>;
  maxMetricCalls?: number;
  budget?: number;
  dryRun?: boolean;
  codingAgent?: CodingAgent;
  preEnrichedFields?: OptimizableField[];
}

export interface OptimizeResult {
  fields: OptimizableField[];
  bestCandidate: Candidate;
  score: number;
  iterations: number;
  writtenBack: boolean;
}

//#endregion

//#region Helper Functions

function hasSourceLocation(
  f: OptimizableField,
  candidate: Candidate,
): f is OptimizableField & {
  sourceLocation: SourceLocation;
} {
  return f.sourceLocation !== undefined && candidate[f.path] !== undefined;
}

function buildWriteBackEntries(
  fields: OptimizableField[],
  bestCandidate: Candidate,
): WriteBackEntry[] {
  return fields
    .filter(
      (
        f,
      ): f is OptimizableField & {
        sourceLocation: SourceLocation;
      } => hasSourceLocation(f, bestCandidate),
    )
    .map((f) => ({
      sourceLocation: f.sourceLocation,
      newValue: bestCandidate[f.path],
    }));
}

//#endregion

//#region Public API

export async function optimize(options: OptimizeOptions): Promise<OptimizeResult> {
  const fields = options.preEnrichedFields ?? discoverFields(options.step);

  if (fields.length === 0) {
    return {
      fields: [],
      bestCandidate: {},
      score: 0,
      iterations: 0,
      writtenBack: false,
    };
  }

  const result = await optimizeWithGepa({
    step: options.step,
    fields,
    runEval: options.runEval,
    maxMetricCalls: options.maxMetricCalls,
  });

  let writtenBack = false;
  if (!options.dryRun) {
    const entriesToWrite = buildWriteBackEntries(fields, result.bestCandidate);
    if (entriesToWrite.length > 0) {
      await writeOptimizedValues(entriesToWrite);
      writtenBack = true;
    }
  }

  return {
    fields,
    bestCandidate: result.bestCandidate,
    score: result.score,
    iterations: result.iterations,
    writtenBack,
  };
}

//#endregion
