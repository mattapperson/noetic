import type { Context } from './context';
import type { Step } from './step';

/** @public Optional lifecycle hooks invoked before and after each step execution. */
export interface AgentHooks {
  /** Awaited before dispatch; skipped on replay. Rejection prevents the body from running. */
  beforeStep?: (step: Step, ctx: Context) => Promise<void>;
  /** Awaited after success, before checkpointing. Skipped on failure and replay; rejection fails the dispatch. */
  afterStep?: (step: Step, result: unknown, ctx: Context) => Promise<void>;
}
