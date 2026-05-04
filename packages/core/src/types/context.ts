import type { ItemSchemaRegistry } from '../schemas/item';
import type { Channel } from './channel';
import type { StepMeta, TokenUsage, Tool } from './common';
import type { FsAdapter } from './fs-adapter';
import type { Item } from './items';
import type { ContextMemory, MemoryLayer } from './memory';
import type { Span } from './observability';
import type { AgentHarnessContract } from './runtime';
import type { ShellAdapter } from './shell-adapter';
import type { SubprocessAdapter } from './subprocess-adapter';

/** @public Append-only log of conversation items accumulated during execution. */
export interface ItemLog {
  readonly items: ReadonlyArray<Item>;
  append(item: Item): void;
}

/**
 * @public Mutable working-directory state shared among the tools attached to a
 * single Context. The reference is fixed for the Context's lifetime; mutate
 * via `setToolCwd` so that all tools observe the new value at execution time.
 *
 * Spawned children receive a snapshot — child mutations do not affect the parent.
 */
export interface CwdState {
  cwd: string;
  previousCwd?: string;
}

/** @public Per-layer contribution to the context window on the most recent LLM call. */
export interface LayerUsageEntry {
  readonly layerId: string;
  readonly tokenCount: number;
  /** Items this layer contributed to the context view for the last LLM call. */
  readonly items: ReadonlyArray<Item>;
}

/** @public Breakdown of the context window as of the most recent LLM call in an execution. */
export interface LastLayerUsage {
  readonly executionId: string;
  readonly modelId: string;
  readonly layers: ReadonlyArray<LayerUsageEntry>;
  readonly systemPromptTokens: number;
  readonly toolsTokens: number;
  readonly historyTokens: number;
  readonly totalUsedTokens: number;
}

/** @public Execution context threaded through every step, carrying state, metrics, and channels. */
export interface Context<TMemory = ContextMemory, TState = unknown> {
  readonly id: string;
  readonly stepCount: number;
  readonly tokens: TokenUsage;
  readonly elapsed: number;
  readonly cost: number;
  state: TState;
  readonly parent: Context<ContextMemory> | null;
  readonly depth: number;
  readonly span: Span;
  readonly threadId: string;
  readonly resourceId?: string;
  readonly itemLog: ItemLog;
  readonly lastStepMeta: StepMeta | null;
  /** Per-layer breakdown of the context window as of the most recent callModel. Undefined until the first LLM call completes. */
  readonly lastLayerUsage?: LastLayerUsage;
  readonly harness: AgentHarnessContract;
  /** Filesystem adapter for virtual or real filesystem access. */
  readonly fs: FsAdapter;
  /** Shell adapter for virtual or real shell command execution. */
  readonly shell: ShellAdapter;
  /** Subprocess adapter for virtual, same-process, or host process execution. */
  readonly subprocess: SubprocessAdapter;
  /**
   * Mutable cwd state shared with the tools bound to this context. Tools
   * resolve relative paths from `cwdState.cwd` at execution time so that an
   * agent `cd` propagates to subsequent tool calls.
   */
  readonly cwdState: CwdState;
  readonly layers?: MemoryLayer[];
  /** Layer provides keyed by layer ID. Access data/functions via `ctx.memory['layerId'].prop`. */
  readonly memory: TMemory;
  /** Unified tool set collected from all LLM steps in the step tree before execution. */
  readonly unifiedTools?: ReadonlyArray<Tool>;
  /** Runtime item schema registry active for this context. */
  readonly itemSchemas?: ItemSchemaRegistry;
  recv<T>(
    channel: Channel<T>,
    opts?: {
      timeout?: number;
    },
  ): Promise<T>;
  send<T>(channel: Channel<T>, value: T): void;
  tryRecv<T>(channel: Channel<T>): T | null;
  checkpoint(): Promise<void>;
  complete<T>(value: T): void;
  readonly completed: boolean;
  readonly completionValue: unknown;
  readonly aborted: boolean;
  readonly abortReason?: string;
  abort(reason?: string): void;
}
