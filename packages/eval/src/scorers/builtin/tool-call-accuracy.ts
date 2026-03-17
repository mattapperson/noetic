import type { ScorerFn } from '../types';

//#region Types

interface ToolCallAccuracyConfig {
  expectedTools: string[];
  strict?: boolean;
}

//#endregion

//#region Helper Functions

function checkStrictMatch(expected: string[], actual: string[]): boolean {
  const sortedExpected = [
    ...expected,
  ].sort();
  const sortedActual = [
    ...actual,
  ].sort();

  if (sortedExpected.length !== sortedActual.length) {
    return false;
  }

  return sortedExpected.every((t, i) => t === sortedActual[i]);
}

//#endregion

//#region Public API

export function toolCallAccuracy(config: ToolCallAccuracyConfig): ScorerFn {
  return async (execution) => {
    const meta = execution.context.lastStepMeta;
    const actualTools = (meta?.toolCalls ?? []).map((tc) => tc.name);

    if (config.strict) {
      const isMatch = checkStrictMatch(config.expectedTools, actualTools);
      return {
        scorerId: 'tool-call-accuracy',
        score: isMatch ? 1.0 : 0.0,
        reason: isMatch
          ? 'Exact tool match'
          : `Expected [${[
              ...config.expectedTools,
            ].sort()}], got [${[
              ...actualTools,
            ].sort()}]`,
        metadata: {
          expected: config.expectedTools,
          actual: actualTools,
          strict: true,
        },
      };
    }

    const matched = config.expectedTools.filter((t) => actualTools.includes(t));
    const score =
      config.expectedTools.length > 0 ? matched.length / config.expectedTools.length : 1.0;

    return {
      scorerId: 'tool-call-accuracy',
      score,
      reason: `${matched.length}/${config.expectedTools.length} expected tools called`,
      metadata: {
        expected: config.expectedTools,
        actual: actualTools,
        matched,
      },
    };
  };
}

//#endregion
