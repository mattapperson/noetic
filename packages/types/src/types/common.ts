import type { DecisionMeta } from './decide';
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
 * @public OpenRouter service tiers. `fast` is an alias for `priority`;
 * `ultrafast` prefers ultrafast endpoints and falls back to `priority`, then
 * default endpoints.
 */
export const ServiceTier = {
  Auto: 'auto',
  Default: 'default',
  Fast: 'fast',
  Flex: 'flex',
  Priority: 'priority',
  Scale: 'scale',
  Ultrafast: 'ultrafast',
} as const;

/** @public Union of OpenRouter service tiers. */
export type ServiceTier = (typeof ServiceTier)[keyof typeof ServiceTier];

/**
 * @public How a model call may use its tools. `auto` lets the model decide,
 * `required` makes it call at least one tool, `none` forbids tool calls.
 */
export const ToolChoiceMode = {
  Auto: 'auto',
  Required: 'required',
  None: 'none',
} as const;

/** @public Union of {@link ToolChoiceMode} values. */
export type ToolChoiceMode = (typeof ToolChoiceMode)[keyof typeof ToolChoiceMode];

/**
 * @public Tool choice for a model call: a {@link ToolChoiceMode}, or
 * `{ tool: name }` to force a call to one client tool. It combines with the
 * step's `tools` restriction (spec 02, Unified Tool Set).
 */
export type ToolChoice =
  | ToolChoiceMode
  | {
      tool: string;
    };

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
  /**
   * Sequences that would cause the model to stop generating.
   * @deprecated Not sent to the model: the OpenRouter Responses API that
   * `callModel` uses has no stop parameter. Accepted so existing steps and
   * workflow documents still parse; it will be removed in the next major.
   */
  stopSequences?: string[];
  /** OpenRouter service tier to request. Omit to use the provider default. */
  serviceTier?: ServiceTier;
}

/** @public Aggregate token counts for an execution (input, output, total, cached). */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
  /**
   * Prompt tokens served from the provider's cache, summed across every model
   * call on this execution. `undefined` — not `0` — while no call has reported a
   * cache figure, preserving the `RoundUsage` distinction between "nothing was
   * cached" and "this provider says nothing about caching".
   */
  cached?: number;
}

/**
 * @public Token counts for a single model round.
 *
 * `cachedTokens` and `cacheWriteTokens` are `undefined` — not `0` — when the
 * provider reports no prompt-cache figures at all. Callers that steer on cache
 * behaviour must tell "nothing was cached" apart from "this provider doesn't
 * say", so the distinction is preserved rather than defaulted away.
 */
export interface RoundUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt tokens served from the provider's cache (a cache *read*). */
  cachedTokens?: number;
  /** Prompt tokens written into the provider's cache (a cache *write*). */
  cacheWriteTokens?: number;
}

/** @public Metadata captured from the most recent step execution. */
export interface StepMeta {
  toolCalls?: FunctionCallItem[];
  usage?: RoundUsage;
  cost?: number;
  /** USD the step's call actually paid; see `LLMResponse.billedCost`. */
  billedCost?: number;
  /** Tier the provider served an `llm` step on; see `LLMResponse.serviceTier`. */
  serviceTier?: string;
  responseItems?: ReadonlyArray<Item>;
  /**
   * Why an ACP agent stopped its turn. Set only by `acp-agent` steps, and the
   * only way a caller can tell a truncated turn (`max_tokens`,
   * `max_turn_requests`) from a complete one — both return normally.
   */
  acpStopReason?: string;
  /** Set by `decide` steps. */
  decision?: DecisionMeta;
}

/** @public Structured response returned by a model adapter after an LLM call. */
export interface LLMResponse {
  items: Item[];
  /** Totals across every round of the call, including rounds rejected and asked again. */
  usage: RoundUsage;
  /**
   * Per-round breakdown, oldest first. Rounds after the first replay the same
   * assembled view plus appended tool traffic, so they hit the prompt cache
   * regardless of whether the first round did — only `rounds[0]` answers
   * "was my prefix cached?".
   */
  rounds?: ReadonlyArray<RoundUsage>;
  /** USD the work behind this response cost, including rounds replayed from a recorded run. */
  cost?: number;
  /**
   * USD this call actually paid: `cost` less what came from replayed rounds, so 0
   * when every round replayed. Absent means the whole `cost` was paid now.
   */
  billedCost?: number;
  /**
   * The tier the provider reports it served, from the last round. Absent when
   * the provider reports none — it is never an echo of the requested tier, so
   * a difference from `params.serviceTier` means a fallback happened.
   */
  serviceTier?: string;
  /**
   * The call stopped early after applying a steer whose `onSteer` layers asked to
   * recall. The caller runs recall again over the conversation the steer joined
   * and continues the call.
   */
  recall?: boolean;
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
