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
 * Declares an OpenRouter server-executed tool on an LLM step. OpenRouter runs
 * the tool (web search, web fetch) provider-side and returns the result item in
 * the response — no client-side execute function is involved.
 *
 * `parameters` keys are camelCase (e.g. `maxResults`, `searchContextSize`); the
 * SDK re-serialises them to the wire format and silently drops unknown keys.
 * @public
 */
export interface ServerToolSpec {
  /** Server tool discriminator. */
  type: 'openrouter:web_search' | 'openrouter:web_fetch';
  /** Optional provider config forwarded to the tool (camelCase keys). */
  parameters?: Record<string, unknown>;
}

/**
 * Distinguishes an inline `ServerToolSpec` from a client `Tool` in a
 * heterogeneous `tools` list. A server-tool spec carries a server-tool `type`
 * discriminator and, unlike a `Tool`, has no `execute` method.
 * @public
 */
export function isServerToolSpec(value: unknown): value is ServerToolSpec {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if ('execute' in value) {
    return false;
  }
  if (!('type' in value)) {
    return false;
  }
  const { type } = value;
  return type === 'openrouter:web_search' || type === 'openrouter:web_fetch';
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
  /**
   * Inference backend. Defaults to `'noetic'` — the Noetic platform
   * (platform.noetic.tools), which provides managed, metered inference
   * authenticated with a Noetic credential. Use `'openrouter'` to call OpenRouter
   * directly (BYOK).
   */
  provider?: 'noetic' | 'openrouter';
  apiKey?: string;
  /**
   * Override the API base URL (advanced / self-host). Defaults to the Noetic
   * platform for the `'noetic'` provider, and the SDK default for `'openrouter'`.
   */
  baseUrl?: string;
  /**
   * When true, sends the `X-OpenRouter-Cache: true` request header on every
   * model call so identical requests are served from cache without re-billing —
   * useful for deterministic re-runs (evals, regression suites).
   */
  cache?: boolean;
}
