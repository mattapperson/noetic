import type { ContextData } from '@noetic-tools/context';
import type { Context, StepMeta, TokenUsage } from '@noetic-tools/types';

/**
 * Internal-only interface for interpreter code that needs to mutate Context fields.
 * NOT exported from the package public API.
 */
export interface MutableContext extends Context<ContextData> {
  stepCount: number;
  tokens: TokenUsage;
  cost: number;
  lastStepMeta: StepMeta | null;
}
