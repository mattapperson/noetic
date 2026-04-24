import type { TurnContext } from '@openrouter/agent';
import type { StepMeta } from './common';
import type { Context } from './context';
import type { FsAdapter } from './fs-adapter';
import type { Item } from './items';
import type { AgentHarnessContract } from './runtime';
import type { ShellAdapter } from './shell-adapter';

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
  readonly harness: AgentHarnessContract;
  /** Filesystem adapter for virtual or real filesystem access. */
  readonly fs: FsAdapter;
  /** Shell adapter for virtual or real shell command execution. */
  readonly shell: ShellAdapter;
  /** Per-layer memory accessor for reading/writing tool-specific state. */
  readonly memory: ToolMemory;
  /** The fully assembled conversation view at the point of tool invocation. */
  readonly assembledView: ReadonlyArray<Item>;
  /** Metadata from the most recent step execution (token usage, tool calls, etc.). */
  readonly lastStepMeta: StepMeta | null;
  /** OpenRouter turn context, when using the OpenRouter SDK adapter. */
  readonly turnContext?: TurnContext;
}
