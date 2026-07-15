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
import type { WriteBackEntry, WriteBackReport } from './source-writer';
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
  /**
   * True only when at least one source literal was actually rewritten AND no
   * entry was skipped. Unchanged candidate values produce no entries, so an
   * optimization that found nothing better reports `writtenBack: false`.
   */
  writtenBack: boolean;
  /** Per-entry outcome of the write-back pass (absent under `dryRun` or when nothing changed). */
  writeBackReport?: WriteBackReport;
}

//#endregion

//#region Helper Functions

function hasSourceLocation(
  f: OptimizableField,
  candidate: Candidate,
): f is OptimizableField & {
  sourceLocation: SourceLocation;
} {
  // Only changed values are written back; expectedValue arms the
  // source-writer's mismatch guard against stale locations.
  return (
    f.sourceLocation !== undefined &&
    candidate[f.path] !== undefined &&
    candidate[f.path] !== f.value
  );
}

/** Exported for tests. Only changed values with source locations become write-back entries. */
export function buildWriteBackEntries(
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
      expectedValue: f.value,
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

  /* Loaded on demand: gepa-bridge pulls in `@ax-llm/ax`, an OPTIONAL peer
   * dependency. A static import would make every `@noetic/eval` consumer —
   * including suites that only use describe/it/scorer — need it installed. */
  const { optimizeWithGepa } = await import('./gepa-bridge');
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
  let writeBackReport: WriteBackReport | undefined;
  if (!options.dryRun) {
    const entriesToWrite = buildWriteBackEntries(fields, result.bestCandidate);
    if (entriesToWrite.length > 0) {
      writeBackReport = await writeOptimizedValues(entriesToWrite);
      for (const skip of writeBackReport.skipped) {
        const { filePath, line, column } = skip.sourceLocation;
        console.warn(`Write-back skipped at ${filePath}:${line}:${column}: ${skip.reason}`);
      }
      writtenBack = writeBackReport.written > 0 && writeBackReport.skipped.length === 0;
    }
  }

  return {
    fields,
    bestCandidate: result.bestCandidate,
    score: result.score,
    iterations: result.iterations,
    writtenBack,
    writeBackReport,
  };
}

//#endregion
