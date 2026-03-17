import type { SourceLocation } from './source-location';

//#region ESM Literal Enums

const FieldKind = {
  System: 'system',
  ToolDescription: 'tool-description',
  ToolName: 'tool-name',
} as const;

type FieldKind = (typeof FieldKind)[keyof typeof FieldKind];

//#endregion

//#region Types

export interface OptimizableField {
  path: string;
  value: string;
  stepId: string;
  fieldKind: FieldKind;
  sourceLocation?: SourceLocation;
}

export type Candidate = Record<string, string>;

export interface OptimizationResult {
  bestCandidate: Candidate;
  score: number;
  iterations: number;
  frontier?: Candidate[];
}

export interface OptimizationRecommendation {
  description: string;
  targetFiles: Array<{
    path: string;
    currentContent: string;
  }>;
  sourceLocations: SourceLocation[];
  gepaFeedback: string;
}

export interface ApplyResult {
  success: boolean;
  changedFiles: string[];
  error?: string;
}

export interface CodingAgent {
  apply(recommendation: OptimizationRecommendation): Promise<ApplyResult>;
}

//#endregion

export { FieldKind };
