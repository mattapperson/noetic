import type { ScoreResult } from '../types/eval';

//#region Public API

export function averageNumbers(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function averageScores(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number {
  return averageNumbers(scores.map((s) => s.score));
}

export function medianScore(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number {
  if (scores.length === 0) {
    return 0;
  }
  const sorted = [
    ...scores,
  ]
    .map((s) => s.score)
    .sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

export function minScore(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number {
  if (scores.length === 0) {
    return 0;
  }
  return Math.min(...scores.map((s) => s.score));
}

export function maxScore(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number {
  if (scores.length === 0) {
    return 0;
  }
  return Math.max(...scores.map((s) => s.score));
}

export function stddevScore(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number {
  if (scores.length <= 1) {
    return 0;
  }
  const mean = averageScores(scores);
  const variance = scores.reduce((sum, s) => sum + (s.score - mean) ** 2, 0) / scores.length;
  return Math.sqrt(variance);
}

//#endregion
