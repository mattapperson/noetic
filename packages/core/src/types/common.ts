import type { ZodTypeAny, z } from 'zod';
import type { FunctionCallItem, Item } from './items';
import type { ToolExecutionContext } from './tool-context';

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

/**
 * Declares tool-owned memory that the runtime materializes into a MemoryLayer.
 * @public
 */
export interface ToolMemoryDeclaration<TState = unknown> {
  /** Shared id — tools with the same id share state. Defaults to `tool.name`. */
  id?: string;
  /** Factory for the initial state. */
  init: () => TState;
  /** Project state into the LLM context. Return null to omit. */
  recall: (state: TState) => string | null;
}

/**
 * A tool definition that an LLM can invoke during execution.
 * @public
 */
export interface Tool<I extends ZodTypeAny = ZodTypeAny, O extends ZodTypeAny = ZodTypeAny> {
  /** Unique tool name used by the LLM for selection. */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** Zod schema validating tool input arguments. */
  input: I;
  /** Zod schema validating tool return value. */
  output: O;
  /** Async function that performs the tool's work. */
  execute(args: z.infer<I>, toolCtx: ToolExecutionContext): Promise<z.infer<O>>;
  /** When true, execution pauses for human approval before running. */
  needsApproval?: boolean;
  /** Optional memory declaration — the runtime generates a MemoryLayer from this. */
  memory?: ToolMemoryDeclaration;
}

/** @public Aggregate token counts for an execution (input, output, total). */
export interface TokenUsage {
  input: number;
  output: number;
  total: number;
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
