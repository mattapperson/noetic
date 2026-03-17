import type { ApplyResult, CodingAgent, OptimizationRecommendation } from '../../types/optimizer';

//#region Public API

export class NoopAgent implements CodingAgent {
  async apply(recommendation: OptimizationRecommendation): Promise<ApplyResult> {
    console.log('[noop-agent] Optimization recommendation:');
    console.log(`  Description: ${recommendation.description}`);
    console.log(`  Target files: ${recommendation.targetFiles.map((f) => f.path).join(', ')}`);
    console.log(`  GEPA feedback: ${recommendation.gepaFeedback}`);
    console.log('  (Apply manually — no coding agent configured)');
    return {
      success: false,
      changedFiles: [],
      error: 'No coding agent configured',
    };
  }
}

//#endregion
