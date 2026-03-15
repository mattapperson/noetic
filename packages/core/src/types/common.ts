import type { ZodTypeAny, z } from 'zod';
import type { Item, FunctionCallItem } from './items';
import type { Context } from './context';

export interface RetryPolicy {
  maxAttempts: number;
  backoff: 'fixed' | 'linear' | 'exponential';
  initialDelay: number;
}

export interface ModelParams {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  stopSequences?: string[];
}

export interface Tool<I extends ZodTypeAny = ZodTypeAny, O extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  input: I;
  output: O;
  execute: (args: z.infer<I>, ctx: Context) => Promise<z.infer<O>>;
  needsApproval?: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  total: number;
}

export interface StepMeta {
  toolCalls?: FunctionCallItem[];
  usage?: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  cost?: number;
  responseItems?: ReadonlyArray<Item>;
}

export interface LLMResponse {
  items: Item[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens?: number };
  cost?: number;
}
