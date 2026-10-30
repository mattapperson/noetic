import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { Channel, ChannelHandle, ExternalChannel } from './channel';
import type { LLMResponse, ModelParams, ToolChoice } from './common';
import type { Context, RestoreContextOptions } from './context';
import type { ContextCacheConfig, ContextCacheStore } from './context-cache';
import type {
  ContextData,
  ContextLayer,
  ProjectionPolicy,
  RecallOptions,
  StorageAdapter,
} from './context-layer';
import type { DecideRequest, DecideResponse, DecisionRecord } from './decide';
import type { DetachedHandle } from './detached';
import type { HarnessPlatform } from './harness-platform';
import type { HarnessResponse, StreamEvent, StreamingItem } from './harness-result';
import type { ExecuteInput, Item } from './items';
import type { Span, TraceExporter } from './observability';
import type { CancelOptions, DrainReport, ExecutionScope, ExecutionStatus } from './runtime';
import type { OnSteerParams, SteeringDecision, SteerVerdict } from './steering';
import type { StepLike, StepsInput, StepsOutput, ValidStepChain } from './step';
import type { Tool } from './tool';

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
      readonly kind: 'draining';
      readonly turnId: string;
      readonly deadline: number;
    }
  | {
      readonly kind: 'aborting';
      readonly turnId: string;
    };

interface ContextCallModelRequestBase {
  model: string;
  items: ReadonlyArray<Item>;
  instructions?: string;
  params?: ModelParams;
  toolChoice?: ToolChoice;
  outputSchema?: StandardSchemaV1;
  /** Explicit non-Zod override/fallback after StandardJSONSchemaV1 conversion. */
  outputJsonSchema?: Record<string, unknown>;
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
  /** Accepted without tools — it carries the broadcaster for streaming (see `CallModelRequestWithoutTools`). */
  ctx?: Context;
  layers?: ContextLayer[];
  allowedToolNames?: undefined;
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
  readonly items: Item[];
  readonly rerenderRequests: ContextRerenderRequest[];
}

export interface ContextRecallLayerOutput {
  layerId: string;
  items: Item[];
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
      readonly output?: StandardSchemaV1<unknown, O>;
    }
  | {
      readonly kind: 'decide';
      readonly id: string;
      readonly _answers?: O;
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
export interface ContextHarness extends HarnessPlatform {
  readonly config: {
    readonly name: string;
    readonly params: Record<string, unknown>;
    /** Harness-wide default projection policy; a step's `projection` overrides it. */
    readonly projection?: ProjectionPolicy;
    /** Tuning for prompt-cache anchoring. */
    readonly contextCache?: ContextCacheConfig;
    /** Default model for `decide` steps. */
    readonly decisionModel?: string;
    /** Whether a resumed run streams again the items its replayed steps emitted. */
    readonly emitItemsOnReplay?: boolean;
  };
  callModel(request: ContextCallModelRequest): Promise<LLMResponse>;
  decide(request: DecideRequest): Promise<DecideResponse>;
  /** Run every layer's `onDecision` hook, in slot order. */
  notifyDecision(layers: ContextLayer[], record: DecisionRecord, ctx: Context): Promise<void>;
  execute(input: ExecuteInput, options?: unknown): Promise<void>;
  getAgentResponse(scope?: unknown): Promise<HarnessResponse>;
  getItemStream(scope?: unknown): AsyncIterable<StreamingItem>;
  getTextStream(scope?: unknown): AsyncIterable<string>;
  getReasoningStream(scope?: unknown): AsyncIterable<string>;
  getFullStream(scope?: unknown): AsyncIterable<StreamEvent>;
  /** Runs a step, or an array of steps in sequence (each output the next one's input). */
  run<I, O>(step: ContextStep<ContextData, I, O>, input: I, ctx: Context): Promise<O>;
  run<const T extends StepLike | ReadonlyArray<StepLike>>(
    steps: T & ValidStepChain<T>,
    input: StepsInput<T>,
    ctx: Context,
  ): Promise<StepsOutput<T>>;
  /** Launches a step, or an array of steps run in sequence, in the background. */
  detachedSpawn<I, O>(
    step: ContextStep<ContextData, I, O>,
    input: I,
    parentCtx: Context,
    overrides?: ContextDetachedSpawnOverrides,
  ): DetachedHandle<O>;
  detachedSpawn<const T extends StepLike | ReadonlyArray<StepLike>>(
    steps: T & ValidStepChain<T>,
    input: StepsInput<T>,
    parentCtx: Context,
    overrides?: ContextDetachedSpawnOverrides,
  ): DetachedHandle<StepsOutput<T>>;
  createContext(opts?: {
    parent?: Context;
    /** Charge this context's usage to `parent` as it is spent. Default `true`. */
    rollUpUsage?: boolean;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    contextLayers?: ContextLayer[];
    cwdInit?: string;
  }): Context;
  getLayerState<T>(executionId: string, layerId: string): T | undefined;
  setLayerState<T>(executionId: string, layerId: string, state: T): void;
  beforeToolCall(
    layers: ContextLayer[],
    toolName: string,
    toolArgs: unknown,
    ctx: Context,
    callId?: string,
  ): Promise<SteeringDecision>;
  afterModelCall(
    layers: ContextLayer[],
    response: LLMResponse,
    ctx: Context,
  ): Promise<SteeringDecision>;
  onSteer?(
    layers: ContextLayer[],
    params: Pick<OnSteerParams, 'steer' | 'point' | 'action' | 'pendingCalls'>,
    ctx: Context,
  ): Promise<SteerVerdict>;
  runAppendPipeline(
    layers: ContextLayer[],
    items: Item[],
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
    opts?: RecallOptions,
  ): Promise<ContextRecallLayerOutput[]>;
  recallLayersEventual(
    layers: ContextLayer[],
    input: string,
    ctx: Context,
    budgets: Map<string, number>,
    opts?: RecallOptions,
  ): Promise<ContextRecallLayerOutput[]>;
  projectHistory(
    layers: ContextLayer[],
    items: ReadonlyArray<Item>,
    ctx: Context,
  ): Promise<ReadonlyArray<Item>>;
  storeLayers(layers: ContextLayer[], response: LLMResponse, ctx: Context): Promise<void>;
  previewRequestItems(scope?: unknown): Promise<ReadonlyArray<Item>>;
  /**
   * Internal-sender channel write. Resolves immediately unless the target
   * queue channel is at capacity, in which case the send parks until a
   * consumer frees a slot (back-pressure; default 30s timeout →
   * `channel_timeout`, abort → `cancelled`).
   */
  send<T>(channel: Channel<T>, value: NoInfer<T>, ctx: Context): Promise<void>;
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
   * `dispose`) bottom-up. A no-op on an already-cancelled context. With
   * `{ drainMs }`, in-flight model calls get that long to finish first.
   */
  cancel(ctx: Context, options?: string | CancelOptions): Promise<DrainReport | undefined>;
  /** Trace exporter spans are flushed to. Defaults to a no-op exporter. */
  readonly traceExporter: TraceExporter;
  createSpan(name: string, parent: Span | null): Span;
  abort(scope?: unknown): Promise<DrainReport | undefined>;
  /** A `run()` execution's state, by its root context's id. */
  getStatus(scope: ExecutionScope): ExecutionStatus;
  getStatus(scope?: unknown): ContextHarnessStatus;
  getQueueSize(scope?: unknown): number;
  /** Cumulative token usage and cost a session has accumulated across its turns. */
  getUsage(scope?: unknown): {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedTokens?: number;
    readonly cost?: number;
  };
  seedSessionHistory(threadId: string, items: ReadonlyArray<Item>): void;
  executeRerender(
    requests: ContextRerenderRequest[],
    layers: ContextLayer[],
    ctx: Context,
    budgets: Map<string, number>,
    query?: string,
  ): Promise<ContextRecallLayerOutput[]>;
}
