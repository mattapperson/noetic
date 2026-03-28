import type { TurnContext } from '@openrouter/sdk';
import type { StepMeta } from './common';
import type { Context } from './context';
import type { Item } from './items';
import type { AgentHarness } from './runtime';

/** @public Accessor for reading and writing per-layer state from within a tool execution. */
export interface ToolMemory {
  get<T>(layerId: string): T | undefined;
  set<T>(layerId: string, state: T): void;
}

/**
 * Context provided to a tool's `execute` function at invocation time.
 * @public
 */
export interface ToolExecutionContext {
  /** The current step execution context (access to item log, parent id, etc.). */
  readonly ctx: Context;
  /** The harness instance executing this tool. */
  readonly harness: AgentHarness;
  /** Per-layer memory accessor for reading/writing tool-specific state. */
  readonly memory: ToolMemory;
  /** The fully assembled conversation view at the point of tool invocation. */
  readonly assembledView: ReadonlyArray<Item>;
  /** Metadata from the most recent step execution (token usage, tool calls, etc.). */
  readonly lastStepMeta: StepMeta | null;
  /** OpenRouter turn context, when using the OpenRouter SDK adapter. */
  readonly turnContext?: TurnContext;
}
