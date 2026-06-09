import type { Step } from '@noetic-tools/core';

import type { OptimizeConfig } from '../types/eval';
import { OptimizeScope } from '../types/eval';
import type {
  Candidate,
  CodingAgent,
  OptimizableField,
  OptimizationRecommendation,
} from '../types/optimizer';
import type { SourceLocation } from '../types/source-location';
import { discoverFields } from './field-discovery';
import type { GepaConfig } from './gepa-bridge';
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
  gepa?: GepaConfig;
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

function buildCodingAgentRecommendation(
  fields: OptimizableField[],
  result: {
    bestCandidate: Candidate;
    score: number;
    iterations: number;
  },
): OptimizationRecommendation {
  const fieldsWithLocation = fields.filter(
    (
      f,
    ): f is OptimizableField & {
      sourceLocation: SourceLocation;
    } => f.sourceLocation !== undefined,
  );

  return {
    description: `Optimization completed: ${result.iterations} iterations, score ${result.score.toFixed(2)}`,
    targetFiles: fieldsWithLocation.map((f) => ({
      path: f.sourceLocation.filePath,
      currentContent: f.value,
    })),
    sourceLocations: fieldsWithLocation.map((f) => f.sourceLocation),
    gepaFeedback: JSON.stringify(result.bestCandidate),
  };
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
    budget: options.budget,
    gepa: options.gepa,
  });

  // L3 optimization: delegate structural changes to coding agent
  if (options.scope === OptimizeScope.Full && options.codingAgent) {
    const recommendation = buildCodingAgentRecommendation(fields, result);
    await options.codingAgent.apply(recommendation);
  }

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
