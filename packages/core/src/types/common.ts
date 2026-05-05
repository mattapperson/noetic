import type { FunctionCallItem, Item } from './items';

/**
 * Policy controlling automatic retry behavior on step failure.
 * @public
 */
export interface RetryPolicy {
  /** Maximum number of execution attempts (including the initial try). */
  maxAttempts: number;
  /** Backoff strategy between retries. */
  backoff: 'fixed' | 'linear' | 'exponential';
  /** Delay in ms before the first retry. */
  initialDelay: number;
  /** Upper bound in ms for the computed delay (caps exponential/linear growth). */
  maxDelay?: number;
}

/**
 * Optional parameters forwarded to the model provider during an LLM step.
 * @public
 */
export interface ModelParams {
  /** Sampling temperature (0 = deterministic, higher = more creative). */
  temperature?: number;
  /** Nucleus sampling threshold (alternative to temperature). */
  topP?: number;
  /** Maximum number of tokens the model may generate. */
  maxTokens?: number;
  /** Sequences that cause the model to stop generating. */
  stopSequences?: string[];
}

/** @public Aggregate token counts for an execution (input, output, total, cached). */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  cached?: number;
}

/** @public Metadata captured from the most recent step execution. */
export interface StepMeta {
  toolCalls?: FunctionCallItem[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
  };
  cost?: number;
  responseItems?: ReadonlyArray<Item>;
}

/** @public Structured response returned by a model adapter after an LLM call. */
export interface LLMResponse {
  items: Item[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
  };
  cost?: number;
}

/** @public Configuration for the LLM provider used by the agent harness. */
export interface LlmProviderConfig {
  provider: 'openrouter';
  apiKey?: string;
}
