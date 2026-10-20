import type { WorkflowDocument } from '@noetic-tools/types';

/**
 * Persisted state shared by the plan layer (`plan.ts`) and its prompt
 * renderers (`plan-prompts.ts`). Lives in its own leaf module so the two can
 * both depend on it without importing each other.
 */

export const PlanPhase = {
  Idle: 'idle',
  Planning: 'planning',
  Executing: 'executing',
  Completed: 'completed',
  Failed: 'failed',
} as const;

export type PlanPhase = (typeof PlanPhase)[keyof typeof PlanPhase];

export interface PlanExecutionEntry {
  timestamp: number;
  version: number;
  outcome: 'success' | 'failure' | 'aborted';
}

export interface PlanState {
  phase: PlanPhase;
  prd: string | null;
  /** The reviewed plan: a complete JSON workflow document. */
  planTree: WorkflowDocument | null;
  /** Named workflows referenced from the tree via `{ kind: 'subflow', ref }` nodes. */
  workflows: Record<string, WorkflowDocument>;
  executionLog: PlanExecutionEntry[];
  version: number;
  /** Identifier of the on-disk plan session (set by `onEnterSession` host callback). */
  planSlug?: string | null;
}
