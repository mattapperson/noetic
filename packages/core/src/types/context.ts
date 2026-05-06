import type { ItemSchemaRegistry } from '../schemas/item';
import type { Channel } from './channel';
import type { LLMResponse, ModelParams, StepMeta, TokenUsage } from './common';
import type { ZodType } from 'zod';
import type { FsAdapter } from './fs-adapter';
import type { ItemLog } from './context-parts/item-log';
import type { DetachedHandle } from './detached';
import type { LastLayerUsage } from './context-parts/layer-usage';
import type { ContextMemory, MemoryLayer, StorageAdapter } from './memory';
import type { Span } from './observability';
import type { ShellAdapter } from './shell-adapter';
import type { SubprocessAdapter } from './subprocess-adapter';
import type { SteeringDecision } from './steering';
import type { Tool } from './tool';
import type { HarnessResponse, StreamEvent, StreamingItem } from './harness-result';
import type { ExecuteInput } from './items';
import type { ChannelHandle, ExternalChannel } from './channel';

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

export type ContextHarnessStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'generating'; readonly startedAt: number; readonly turnId: string }
  | { readonly kind: 'aborting'; readonly turnId: string };

interface ContextCallModelRequestBase {
  model: string;
  items: ReadonlyArray<import('./items').Item>;
  instructions?: string;
  params?: ModelParams;
  outputSchema?: ZodType;
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
  signal?: AbortSignal;
}

interface ContextCallModelRequestWithTools extends ContextCallModelRequestBase {
  tools: Tool[];
  ctx: Context;
  layers?: MemoryLayer[];
  allowedToolNames?: string[];
}

interface ContextCallModelRequestWithoutTools extends ContextCallModelRequestBase {
  tools?: undefined;
  ctx?: undefined;
  layers?: undefined;
}

export type ContextCallModelRequest =
  | ContextCallModelRequestWithTools
  | ContextCallModelRequestWithoutTools;

export interface ContextDetachedSpawnOverrides {
  threadId?: string;
  resourceId?: string;
  cwdInit?: string;
}

export interface ContextRerenderRequest {
  layerId: string;
  slot: number;
  timing: 'immediate' | 'batched';
  scope: 'self' | 'slot-after' | 'all';
}

export interface ContextAppendPipelineResult {
  readonly items: import('./items').Item[];
  readonly rerenderRequests: ContextRerenderRequest[];
}

export interface ContextRecallLayerOutput {
  layerId: string;
  items: import('./items').Item[];
  tokenCount: number;
}

export type ContextStep<TMemory = ContextMemory, I = unknown, O = unknown> =
  | {
      readonly kind: 'run';
      readonly id: string;
      readonly execute: (input: I, ctx: Context<TMemory>) => Promise<O>;
    }
  | {
      readonly kind: 'llm';
      readonly id: string;
      readonly output?: ZodType<O>;
    }
  | {
      readonly kind: 'loop';
      readonly id: string;
      readonly steps: ReadonlyArray<ContextStep<TMemory, I, O>>;
      readonly prepareNext?: (output: O, verdict: unknown, ctx: Context<TMemory>) => I;
    }
  | {
      readonly kind: string;
      readonly id: string;
    };

/** @public Runtime surface exposed on Context without coupling Context's definition to the runtime type module. */
export interface ContextHarness {
  readonly config: { readonly name: string; readonly params: Record<string, unknown> };
  readonly fs: FsAdapter;
  readonly shell: ShellAdapter;
  readonly subprocess: SubprocessAdapter;
  readonly rootCwdState: CwdState;
  callModel(request: ContextCallModelRequest): Promise<LLMResponse>;
  execute(input: ExecuteInput, options?: unknown): Promise<void>;
  getAgentResponse(scope?: unknown): Promise<HarnessResponse>;
  getItemStream(scope?: unknown): AsyncIterable<StreamingItem>;
  getTextStream(scope?: unknown): AsyncIterable<string>;
  getReasoningStream(scope?: unknown): AsyncIterable<string>;
  getFullStream(scope?: unknown): AsyncIterable<StreamEvent>;
  run<I, O>(step: ContextStep<ContextMemory, I, O>, input: I, ctx: Context): Promise<O>;
  detachedSpawn<I, O>(
    step: unknown,
    input: I,
    parentCtx: Context,
    overrides?: ContextDetachedSpawnOverrides,
  ): DetachedHandle<O>;
  createContext(opts?: {
    parent?: Context;
    items?: import('./items').Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    memory?: MemoryLayer[];
    cwdInit?: string;
  }): Context;
  setRootCwd(nextCwd: string): void;
  getLayerState<T>(executionId: string, layerId: string): T | undefined;
  setLayerState<T>(executionId: string, layerId: string, state: T): void;
  beforeToolCall(
    layers: MemoryLayer[],
    toolName: string,
    toolArgs: unknown,
    ctx: Context,
  ): Promise<SteeringDecision>;
  afterModelCall(
    layers: MemoryLayer[],
    response: LLMResponse,
    ctx: Context,
  ): Promise<SteeringDecision>;
  runAppendPipeline(
    layers: MemoryLayer[],
    items: import('./items').Item[],
    ctx: Context,
  ): Promise<ContextAppendPipelineResult>;
  recallLayers(
    layers: MemoryLayer[],
    input: string,
    ctx: Context,
  ): Promise<ContextRecallLayerOutput[]>;
  projectHistory(
    layers: MemoryLayer[],
    items: ReadonlyArray<import('./items').Item>,
    ctx: Context,
  ): Promise<ReadonlyArray<import('./items').Item>>;
  storeLayers(layers: MemoryLayer[], response: LLMResponse, ctx: Context): Promise<void>;
  previewRequestItems(scope?: unknown): Promise<ReadonlyArray<import('./items').Item>>;
  send<T>(channel: Channel<T>, value: T, ctx: Context): void;
  recv<T>(channel: Channel<T>, ctx: Context, opts?: { timeout?: number }): Promise<T>;
  tryRecv<T>(channel: Channel<T>, ctx: Context): T | null;
  getChannelHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T>;
  initLayers(layers: MemoryLayer[], ctx: Context, storage: StorageAdapter): Promise<void>;
  disposeLayers(layers: MemoryLayer[], ctx: Context): Promise<void>;
  checkpoint(ctx: Context): Promise<void>;
  restore(executionId: string): Promise<Context | null>;
  cancel(ctx: Context, reason?: string): Promise<void>;
  createSpan(name: string, parent: Span | null): Span;
  abort(scope?: unknown): Promise<void>;
  getStatus(scope?: unknown): ContextHarnessStatus;
  getQueueSize(scope?: unknown): number;
  seedSessionHistory(threadId: string, items: ReadonlyArray<import('./items').Item>): void;
  executeRerender(
    requests: ContextRerenderRequest[],
    layers: MemoryLayer[],
    ctx: Context,
    budgets: Map<string, number>,
    query?: string,
  ): Promise<ContextRecallLayerOutput[]>;
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
  readonly harness: ContextHarness;
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
