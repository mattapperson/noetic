/**
 * Step Data Extractors
 *
 * Plugin-based system for extracting step-specific data from span attributes.
 * Each step kind registers its own extractor function that knows how to
 * build stepData from span attributes.
 */

import type { TokenUsage } from './types';

/** Step data extractor function type */
export type StepDataExtractor = (
  spanAttrs: Record<string, unknown>,
  tokenUsage: TokenUsage,
  cost: number,
) => Record<string, unknown>;

/** Registry of step data extractors by step kind */
export const stepDataExtractors = new Map<string, StepDataExtractor>();

/**
 * Register a step data extractor for a specific step kind
 */
export function registerStepDataExtractor(kind: string, extractor: StepDataExtractor): void {
  stepDataExtractors.set(kind, extractor);
}

/**
 * Get the step data extractor for a step kind
 * Falls back to a generic extractor if no specific one is registered
 */
export function getStepDataExtractor(kind: string): StepDataExtractor {
  return stepDataExtractors.get(kind) ?? genericStepDataExtractor;
}

/**
 * Generic fallback extractor for unknown step kinds
 */
const genericStepDataExtractor: StepDataExtractor = (spanAttrs) => {
  const result: Record<string, unknown> = {};
  // Only include description if provided
  if (spanAttrs.stepDescription) {
    result.description = spanAttrs.stepDescription;
  }
  return result;
};

// ============================================================================
// Built-in Step Extractors
// ============================================================================

/** LLM step extractor */
registerStepDataExtractor('llm', (spanAttrs, tokenUsage, cost) => {
  const result: Record<string, unknown> = {
    model: spanAttrs.model || 'unknown',
    messages: spanAttrs.messages || [],
    toolCalls: spanAttrs.toolCalls || [],
    tokenUsage,
    cost,
  };
  // Only include systemPrompt if provided
  if (spanAttrs.systemPrompt) {
    result.systemPrompt = spanAttrs.systemPrompt;
  }
  return result;
});

/** Tool step extractor */
registerStepDataExtractor('tool', (spanAttrs) => {
  return {
    toolName: spanAttrs.toolName || 'unknown',
    arguments: spanAttrs.toolArguments,
    result: spanAttrs.toolResult,
  };
});

/** Fork step extractor */
registerStepDataExtractor('fork', (spanAttrs) => {
  const result: Record<string, unknown> = {
    mode: spanAttrs.forkMode || 'race',
    pathCount: spanAttrs.forkPathCount || 0,
  };
  // Only include winnerPath if defined
  if (spanAttrs.winnerPath !== undefined) {
    result.winnerPath = spanAttrs.winnerPath;
  }
  return result;
});

/** Loop step extractor */
registerStepDataExtractor('loop', (spanAttrs) => {
  const result: Record<string, unknown> = {
    stepCount: spanAttrs.loopStepCount || 0,
  };
  // Only include iteration info if provided
  if (spanAttrs.currentIteration !== undefined) {
    result.currentIteration = spanAttrs.currentIteration;
  }
  if (spanAttrs.maxIterations !== undefined) {
    result.maxIterations = spanAttrs.maxIterations;
  }
  return result;
});

/** Spawn step extractor */
registerStepDataExtractor('spawn', (spanAttrs) => {
  const result: Record<string, unknown> = {
    childId: spanAttrs.spawnChildId || 'unknown',
  };
  // Only include childKind if provided
  if (spanAttrs.spawnChildKind) {
    result.childKind = spanAttrs.spawnChildKind;
  }
  return result;
});

/** Branch step extractor */
registerStepDataExtractor('branch', (spanAttrs) => {
  const result: Record<string, unknown> = {
    branchType: spanAttrs.branchType || 'dynamic',
  };
  // Only include optional fields if provided
  if (spanAttrs.selectedPath !== undefined) {
    result.selectedPath = spanAttrs.selectedPath;
  }
  if (spanAttrs.condition) {
    result.condition = spanAttrs.condition;
  }
  return result;
});

/** Run step extractor (default/simple steps) */
registerStepDataExtractor('run', (spanAttrs) => {
  const result: Record<string, unknown> = {};
  // Only include description if provided
  if (spanAttrs.stepDescription) {
    result.description = spanAttrs.stepDescription;
  }
  return result;
});

/** Provide step extractor */
registerStepDataExtractor('provide', (spanAttrs) => {
  const result: Record<string, unknown> = {
    providerId: spanAttrs.providerId,
    provides: spanAttrs.provides,
  };
  // Only include description if provided
  if (spanAttrs.stepDescription) {
    result.description = spanAttrs.stepDescription;
  }
  return result;
});
