import type { Step } from '@noetic-tools/core';

import type { OptimizeConfig } from '../types/eval';
import { OptimizeScope } from '../types/eval';
import type {
  ApplyResult,
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
import { assertWritableUnderVersionControl } from './write-guard';

//#region Types

export interface OptimizeOptions {
  step: Step;
  scope: OptimizeConfig['scope'];
  runEval: (step: Step) => Promise<Record<string, number>>;
  maxMetricCalls?: number;
  dryRun?: boolean;
  /**
   * Skip the version-control write-back guard. By default every target file
   * must be git-tracked and unmodified before the optimizer rewrites it —
   * see write-guard.ts. CLI: --force-dirty.
   */
  forceDirty?: boolean;
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
  /**
   * Outcome of the L3 coding-agent pass (absent when no agent ran). A failed
   * apply is reported, never swallowed — the caller decides whether a partial
   * optimization is acceptable.
   */
  codingAgentResult?: ApplyResult;
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
   * dependency. A static import would make every `@noetic-tools/eval` consumer —
   * including suites that only use describe/it/scorer — need it installed. */
  const { optimizeWithGepa } = await import('./gepa-bridge');
  const result = await optimizeWithGepa({
    step: options.step,
    fields,
    runEval: options.runEval,
    maxMetricCalls: options.maxMetricCalls,
    gepa: options.gepa,
  });

  const entriesToWrite = options.dryRun ? [] : buildWriteBackEntries(fields, result.bestCandidate);
  const runAgent = options.scope === OptimizeScope.Full && options.codingAgent !== undefined;

  /* Version-control guard runs BEFORE anything mutates files — over the union
   * of the L1 write-back targets and the L3 agent's target files. Running the
   * agent first meant the guard then saw the agent's own uncommitted edits as
   * "dirty" and blocked the literal write-back it exists to protect. */
  const agentTargetFiles = runAgent
    ? buildCodingAgentRecommendation(fields, result).targetFiles.map((f) => f.path)
    : [];
  const filesToGuard = [
    ...new Set([
      ...entriesToWrite.map((e) => e.sourceLocation.filePath),
      ...agentTargetFiles,
    ]),
  ];
  if (filesToGuard.length > 0) {
    const guarded = assertWritableUnderVersionControl(filesToGuard, options.forceDirty);
    if (options.forceDirty && guarded.some((v) => v.status !== 'clean')) {
      console.warn(
        `optimize: writing into ${guarded.filter((v) => v.status !== 'clean').length} dirty/untracked file(s) under --force-dirty.`,
      );
    }
  }

  // L3 optimization: delegate structural changes to the coding agent. Its
  // result is surfaced, never discarded — a failed apply must be visible.
  let codingAgentResult: ApplyResult | undefined;
  if (runAgent && options.codingAgent) {
    const recommendation = buildCodingAgentRecommendation(fields, result);
    codingAgentResult = await options.codingAgent.apply(recommendation);
    if (!codingAgentResult.success) {
      console.warn(
        `optimize: coding agent apply failed${codingAgentResult.error ? `: ${codingAgentResult.error}` : ''}`,
      );
    }
  }

  let writtenBack = false;
  let writeBackReport: WriteBackReport | undefined;
  if (entriesToWrite.length > 0) {
    /* Files the agent just rewrote have stale source locations — the line/col
     * recorded at discovery no longer describes the file. Splicing anyway
     * would corrupt source (the mismatch guard catches value drift, but a
     * moved literal at the same position would still splice wrong). Skip
     * those entries and report them. */
    const agentChanged = new Set(codingAgentResult?.changedFiles ?? []);
    const safeEntries = entriesToWrite.filter((e) => !agentChanged.has(e.sourceLocation.filePath));
    const staleEntries = entriesToWrite.filter((e) => agentChanged.has(e.sourceLocation.filePath));
    writeBackReport = await writeOptimizedValues(safeEntries);
    for (const stale of staleEntries) {
      writeBackReport.skipped.push({
        sourceLocation: stale.sourceLocation,
        reason: 'file rewritten by the coding agent this run; source location is stale',
      });
    }
    for (const skip of writeBackReport.skipped) {
      const { filePath, line, column } = skip.sourceLocation;
      console.warn(`Write-back skipped at ${filePath}:${line}:${column}: ${skip.reason}`);
    }
    writtenBack = writeBackReport.written > 0 && writeBackReport.skipped.length === 0;
  }

  return {
    fields,
    bestCandidate: result.bestCandidate,
    score: result.score,
    iterations: result.iterations,
    writtenBack,
    writeBackReport,
    codingAgentResult,
  };
}

//#endregion
