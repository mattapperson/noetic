import type { Context } from './context';
import type { TokenUsage, StepMeta } from './common';

/**
 * Internal-only interface for interpreter code that needs to mutate Context fields.
 * NOT exported from the package public API.
 */
export interface MutableContext extends Context {
  stepCount: number;
  tokens: TokenUsage;
  cost: number;
  lastStepMeta: StepMeta | null;
}
