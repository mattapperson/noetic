/**
 * Step Data Extractors - Plugin Architecture
 *
 * A clean, extensible plugin system for extracting step-specific data from span attributes.
 * Each step kind registers its own extractor function that transforms span attributes into
 * the stepData object used by the UI for rendering.
 *
 * @example
 * ```typescript
 * // Register a custom step extractor
 * import { registerStepDataExtractor } from '@noetic/ui/runtime/step-extractors';
 *
 * registerStepDataExtractor('myCustomStep', (spanAttrs, tokenUsage, cost) => {
 *   return {
 *     customField: spanAttrs.customField,
 *     tokenUsage,
 *     cost,
 *   };
 * });
 * ```
 *
 * @example
 * ```typescript
 * // Check if an extractor exists before using
 * import { hasStepDataExtractor, getStepDataExtractor } from '@noetic/ui/runtime/step-extractors';
 *
 * if (hasStepDataExtractor('llm')) {
 *   const extractor = getStepDataExtractor('llm');
 *   const data = extractor(spanAttrs, tokenUsage, cost);
 * }
 * ```
 */

import type { TokenUsage } from './types';

/**
 * Step data extractor function signature.
 * Called by the exporter to build stepData from span attributes.
 *
 * @param spanAttrs - The span attributes from the execution trace
 * @param tokenUsage - Token usage statistics (input/output/total)
 * @param cost - The execution cost in USD
 * @returns The stepData object for UI rendering
 */
export type StepDataExtractor = (
  spanAttrs: Record<string, unknown>,
  tokenUsage: TokenUsage,
  cost: number,
) => Record<string, unknown>;

/** Internal registry of extractors by step kind */
const registry = new Map<string, StepDataExtractor>();

/**
 * Register a step data extractor for a specific step kind.
 * Overwrites any existing extractor for the same kind.
 *
 * @param kind - The step kind identifier (e.g., 'llm', 'tool', 'loop')
 * @param extractor - The extractor function that builds stepData
 * @throws Error if kind is not a non-empty string
 *
 * @example
 * ```typescript
 * registerStepDataExtractor('webhook', (attrs, tokens, cost) => ({
 *   url: attrs.webhookUrl,
 *   method: attrs.httpMethod || 'POST',
 *   tokenUsage: tokens,
 *   cost,
 * }));
 * ```
 */
export function registerStepDataExtractor(kind: string, extractor: StepDataExtractor): void {
  if (!kind || typeof kind !== 'string') {
    throw new Error('Step kind must be a non-empty string');
  }
  if (typeof extractor !== 'function') {
    throw new Error('Extractor must be a function');
  }
  registry.set(kind, extractor);
}

/**
 * Get the step data extractor for a step kind.
 * Falls back to a generic extractor if no specific one is registered.
 *
 * @param kind - The step kind identifier
 * @returns The extractor function (registered or generic fallback)
 *
 * @example
 * ```typescript
 * const extractor = getStepDataExtractor('llm');
 * const data = extractor(spanAttrs, tokenUsage, cost);
 * ```
 */
export function getStepDataExtractor(kind: string): StepDataExtractor {
  return registry.get(kind) ?? genericStepDataExtractor;
}

/**
 * Check if an extractor is registered for a step kind.
 *
 * @param kind - The step kind identifier
 * @returns True if an extractor is registered, false otherwise
 *
 * @example
 * ```typescript
 * if (hasStepDataExtractor('llm')) {
 *   // Use the LLM-specific extractor
 * }
 * ```
 */
export function hasStepDataExtractor(kind: string): boolean {
  return registry.has(kind);
}

/**
 * Unregister a step data extractor.
 * Useful for testing or hot-swapping implementations.
 *
 * @param kind - The step kind identifier to unregister
 * @returns True if an extractor was removed, false if none existed
 *
 * @example
 * ```typescript
 * unregisterStepDataExtractor('deprecatedStep');
 * ```
 */
export function unregisterStepDataExtractor(kind: string): boolean {
  return registry.delete(kind);
}

/**
 * Get all registered step kinds.
 * Useful for debugging or listing available extractors.
 *
 * @returns Array of registered step kind identifiers
 */
export function getRegisteredStepKinds(): string[] {
  return Array.from(registry.keys());
}

/**
 * Clear all registered extractors.
 * Primarily for testing purposes.
 * Note: This also clears built-in extractors!
 */
export function clearStepDataExtractors(): void {
  registry.clear();
}

/**
 * Generic fallback extractor for unknown step kinds.
 * Only includes basic fields if available.
 */
const genericStepDataExtractor: StepDataExtractor = (spanAttrs, tokenUsage, cost) => {
  const result: Record<string, unknown> = {
    tokenUsage,
    cost,
  };

  if (spanAttrs.stepDescription) {
    result.description = spanAttrs.stepDescription;
  }

  return result;
};

// ============================================================================
// Built-in Step Extractors
// ============================================================================

let builtinsRegistered = false;

/**
 * Register all built-in step data extractors.
 * Idempotent — subsequent calls are no-ops.
 */
export function registerBuiltinExtractors(): void {
  if (builtinsRegistered) {
    return;
  }
  builtinsRegistered = true;

  /** LLM step - Large Language Model calls */
  registerStepDataExtractor('llm', (spanAttrs, tokenUsage, cost) => {
    const result: Record<string, unknown> = {
      model: spanAttrs.model || 'unknown',
      messages: spanAttrs.messages || [],
      toolCalls: spanAttrs.toolCalls || [],
      tokenUsage,
      cost,
    };

    if (spanAttrs.systemPrompt) {
      result.systemPrompt = spanAttrs.systemPrompt;
    }

    return result;
  });

  /** Tool step - Tool/function invocations */
  registerStepDataExtractor('tool', (spanAttrs, tokenUsage, cost) => ({
    toolName: spanAttrs.toolName || 'unknown',
    arguments: spanAttrs.toolArguments,
    result: spanAttrs.toolResult,
    tokenUsage,
    cost,
  }));

  /** Fork step - Concurrent execution paths */
  registerStepDataExtractor('fork', (spanAttrs, tokenUsage, cost) => {
    const result: Record<string, unknown> = {
      mode: spanAttrs.forkMode || 'race',
      pathCount: spanAttrs.forkPathCount || 0,
      tokenUsage,
      cost,
    };

    if (spanAttrs.winnerPath !== undefined) {
      result.winnerPath = spanAttrs.winnerPath;
    }

    return result;
  });

  /** Loop step - Iterative execution */
  registerStepDataExtractor('loop', (spanAttrs, tokenUsage, cost) => {
    return {
      iteration: spanAttrs.currentIteration || 0,
      totalIterations: spanAttrs.totalIterations || 0,
      maxIterations: spanAttrs.maxIterations || 0,
      tokenUsage,
      cost,
    };
  });

  /** Spawn step - Child process/agent spawning */
  registerStepDataExtractor('spawn', (spanAttrs, tokenUsage, cost) => {
    return {
      childStepId: spanAttrs.spawnChildId || 'unknown',
      childStepKind: spanAttrs.spawnChildKind || 'run',
      tokenUsage,
      cost,
    };
  });

  /** Branch step - Conditional routing */
  registerStepDataExtractor('branch', (spanAttrs, tokenUsage, cost) => {
    return {
      condition: spanAttrs.condition,
      selectedPath: spanAttrs.selectedPath,
      tokenUsage,
      cost,
    };
  });

  /** Run step - Generic execution step */
  registerStepDataExtractor('run', (spanAttrs, tokenUsage, cost) => {
    const result: Record<string, unknown> = {
      tokenUsage,
      cost,
    };

    if (spanAttrs.stepDescription) {
      result.description = spanAttrs.stepDescription;
    }

    return result;
  });

  /** Provide step - Dependency injection/provisioning */
  registerStepDataExtractor('provide', (spanAttrs, tokenUsage, cost) => {
    const result: Record<string, unknown> = {
      providerId: spanAttrs.providerId,
      provides: spanAttrs.provides,
      tokenUsage,
      cost,
    };

    if (spanAttrs.stepDescription) {
      result.description = spanAttrs.stepDescription;
    }

    return result;
  });
}

/**
 * Reset the builtins-registered guard.
 * For test teardown only — allows re-registration after clearStepDataExtractors().
 */
export function resetBuiltinsGuard(): void {
  builtinsRegistered = false;
}
