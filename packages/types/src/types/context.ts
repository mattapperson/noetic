import type { ZodType } from 'zod';
import type { ItemSchemaRegistry } from '../schemas/item';
import type { Channel, ChannelHandle, ExternalChannel } from './channel';
import type { LLMResponse, ModelParams, StepMeta, TokenUsage } from './common';
import type { ContextCacheConfig, ContextCacheStore } from './context-cache';
import type { ContextData, ContextLayer, ProjectionPolicy, StorageAdapter } from './context-layer';
import type { ItemLog } from './context-parts/item-log';
import type { LastLayerUsage } from './context-parts/layer-usage';
import type { DetachedHandle } from './detached';
import type { FsAdapter } from './fs-adapter';
import type { HarnessResponse, StreamEvent, StreamingItem } from './harness-result';
import type { ExecuteInput } from './items';
import type { Span, TraceExporter } from './observability';
import type { ShellAdapter } from './shell-adapter';
import type { SteeringDecision } from './steering';
import type { SubprocessAdapter } from './subprocess-adapter';
import type { Tool } from './tool';

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
  | {
      readonly kind: 'idle';
    }
  | {
      readonly kind: 'generating';
      readonly startedAt: number;
      readonly turnId: string;
    }
  | {
      readonly kind: 'aborting';
      readonly turnId: string;
    };

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
  layers?: ContextLayer[];
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

/**
 * @public Caller-supplied wiring forwarded to the `createContext` call that
 * `harness.restore()` makes internally.
 *
 * A snapshot recovers the item log, layer state, cwd, and identity — it cannot
 * recover the live objects a host attached when it built the original context
 * (event broadcasters, queues, per-host state). Pass the same wiring here that
 * was passed to `createContext` originally, or the resumed run silently loses
 * it.
 *
 * Snapshot-owned fields (`items`, `threadId`, `resourceId`, `cwdInit`) are
 * deliberately absent: they always come from the persisted snapshot, so
 * accepting them here would only offer a value that gets ignored.
 *
 * Anything a host attaches *after* construction — `Object.assign`ed fields,
 * abort registration — stays the host's responsibility and can be applied to
 * the context `restore()` returns.
 */
export interface RestoreContextOptions {
  /** Live parent context, when the restored execution hangs under one. */
  parent?: Context;
  /** Opaque per-execution state, same as `createContext({ state })`. */
  state?: unknown;
  /** Context layers for the restored context. Defaults to the harness's configured layers. */
  context?: ContextLayer[];
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

export type ContextStep<TContext = ContextData, I = unknown, O = unknown> =
  | {
      readonly kind: 'runCode';
      readonly id: string;
      readonly execute: (input: I, ctx: Context<TContext>) => Promise<O>;
    }
  | {
      readonly kind: 'callModel';
      readonly id: string;
      readonly output?: ZodType<O>;
    }
  | {
      readonly kind: 'loop';
      readonly id: string;
      readonly steps: ReadonlyArray<ContextStep<TContext, I, O>>;
      readonly prepareNext?: (output: O, verdict: unknown, ctx: Context<TContext>) => I;
    }
  | {
      readonly kind: string;
      readonly id: string;
    };

/** @public Runtime surface exposed on Context without coupling Context's definition to the runtime type module. */
export interface ContextHarness {
  readonly config: {
    readonly name: string;
    readonly params: Record<string, unknown>;
    /** Harness-wide default projection policy; a step's `projection` overrides it. */
    readonly projection?: ProjectionPolicy;
    /** Tuning for prompt-cache anchoring. */
    readonly contextCache?: ContextCacheConfig;
  };
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
  run<I, O>(step: ContextStep<ContextData, I, O>, input: I, ctx: Context): Promise<O>;
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
    context?: ContextLayer[];
    cwdInit?: string;
  }): Context;
  setRootCwd(nextCwd: string): void;
  getLayerState<T>(executionId: string, layerId: string): T | undefined;
  setLayerState<T>(executionId: string, layerId: string, state: T): void;
  beforeToolCall(
    layers: ContextLayer[],
    toolName: string,
    toolArgs: unknown,
    ctx: Context,
  ): Promise<SteeringDecision>;
  afterModelCall(
    layers: ContextLayer[],
    response: LLMResponse,
    ctx: Context,
  ): Promise<SteeringDecision>;
  runAppendPipeline(
    layers: ContextLayer[],
    items: import('./items').Item[],
    ctx: Context,
  ): Promise<ContextAppendPipelineResult>;
  /** Pinned anchor output and epoch bookkeeping for prompt-cache anchoring. Absent on a harness that predates it. */
  readonly contextCache?: ContextCacheStore;
  recallLayers(
    layers: ContextLayer[],
    input: string,
    ctx: Context,
  ): Promise<ContextRecallLayerOutput[]>;
  recallLayersAtomic(
    layers: ContextLayer[],
    input: string,
    ctx: Context,
    budgets: Map<string, number>,
  ): Promise<ContextRecallLayerOutput[]>;
  recallLayersEventual(
    layers: ContextLayer[],
    input: string,
    ctx: Context,
    budgets: Map<string, number>,
  ): Promise<ContextRecallLayerOutput[]>;
  projectHistory(
    layers: ContextLayer[],
    items: ReadonlyArray<import('./items').Item>,
    ctx: Context,
  ): Promise<ReadonlyArray<import('./items').Item>>;
  storeLayers(layers: ContextLayer[], response: LLMResponse, ctx: Context): Promise<void>;
  previewRequestItems(scope?: unknown): Promise<ReadonlyArray<import('./items').Item>>;
  /**
   * Internal-sender channel write. Resolves immediately unless the target
   * queue channel is at capacity, in which case the send parks until a
   * consumer frees a slot (back-pressure; default 30s timeout →
   * `channel_timeout`, abort → `cancelled`).
   */
  send<T>(channel: Channel<T>, value: T, ctx: Context): Promise<void>;
  recv<T>(
    channel: Channel<T>,
    ctx: Context,
    opts?: {
      timeout?: number;
    },
  ): Promise<T>;
  tryRecv<T>(channel: Channel<T>, ctx: Context): T | null;
  getChannelHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T>;
  /** Read-side counterpart to `getChannelHandle` — see `AgentHarnessContract.getChannelStream`. */
  getChannelStream<T>(channel: ExternalChannel<T>, executionId: string): AsyncIterable<T>;
  initLayers(layers: ContextLayer[], ctx: Context, storage: StorageAdapter): Promise<void>;
  disposeLayers(layers: ContextLayer[], ctx: Context): Promise<void>;
  checkpoint(ctx: Context): Promise<void>;
  restore(executionId: string, opts?: RestoreContextOptions): Promise<Context | null>;
  /**
   * Cancel an execution: abort `ctx` and every live descendant context, then
   * run context-layer teardown (`onComplete` with `outcome: 'aborted'`, then
   * `dispose`) bottom-up. A no-op on an already-cancelled context.
   */
  cancel(ctx: Context, reason?: string): Promise<void>;
  /** Trace exporter spans are flushed to. Defaults to a no-op exporter. */
  readonly traceExporter: TraceExporter;
  createSpan(name: string, parent: Span | null): Span;
  abort(scope?: unknown): Promise<void>;
  getStatus(scope?: unknown): ContextHarnessStatus;
  getQueueSize(scope?: unknown): number;
  seedSessionHistory(threadId: string, items: ReadonlyArray<import('./items').Item>): void;
  executeRerender(
    requests: ContextRerenderRequest[],
    layers: ContextLayer[],
    ctx: Context,
    budgets: Map<string, number>,
    query?: string,
  ): Promise<ContextRecallLayerOutput[]>;
}

/** @public Execution context threaded through every step, carrying state, metrics, and channels. */
export interface Context<TContext = ContextData, TState = unknown> {
  readonly id: string;
  readonly stepCount: number;
  readonly tokens: TokenUsage;
  readonly elapsed: number;
  readonly cost: number;
  state: TState;
  readonly parent: Context<ContextData> | null;
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
  readonly layers?: ContextLayer[];
  /** Layer provides keyed by layer ID. Access data/functions via `ctx.context['layerId'].prop`. */
  readonly context: TContext;
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
  /**
   * Send a value into a channel. Resolves immediately for value/topic
   * channels and for queue channels below capacity. When a queue channel is
   * at capacity the returned promise parks until a consumer dequeues an item
   * (back-pressure): after the default 30s timeout it rejects with
   * `channel_timeout`, and aborting the context rejects it with `cancelled`.
   */
  send<T>(channel: Channel<T>, value: T): Promise<void>;
  tryRecv<T>(channel: Channel<T>): T | null;
  checkpoint(): Promise<void>;
  complete<T>(value: T): void;
  readonly completed: boolean;
  readonly completionValue: unknown;
  readonly aborted: boolean;
  readonly abortReason?: string;
  /**
   * Cancel this context and everything running beneath it. The first call wins
   * (later calls are no-ops, so `abortReason` is stable), and it cascades
   * *down* the execution tree: every live fork path and spawn child is aborted
   * too. It never travels up — aborting a child leaves the parent running.
   *
   * Aborting rejects operations blocked on the context (channel `recv` waiters,
   * parked back-pressure senders) with `cancelled`, cuts short the in-flight
   * model call or sub-harness turn, and makes the next step boundary throw
   * `cancelled`. Context-layer teardown is NOT run — use
   * `harness.cancel(ctx, reason)` for that.
   */
  abort(reason?: string): void;
}
