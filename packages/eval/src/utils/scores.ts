import type { ScoreResult } from '../types/eval';

//#region Public API

export function averageScores(scores: ReadonlyArray<Pick<ScoreResult, 'score'>>): number {
  if (scores.length === 0) {
    return 0;
  }
  return scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
}

//#endregion
