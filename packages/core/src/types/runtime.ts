import type { ZodType } from 'zod';
import type { Channel, ChannelHandle, ExternalChannel } from './channel';
import type { LLMResponse, ModelParams, Tool } from './common';
import type { Context } from './context';
import type { DetachedHandle } from './detached';
import type { FsAdapter } from './fs-adapter';
import type { HarnessResponse, StreamEvent, StreamingItem } from './harness-result';
import type { ExecuteInput, Item } from './items';
import type { ContextMemory, MemoryLayer, StorageAdapter } from './memory';
import type { Span } from './observability';
import type { ShellAdapter } from './shell-adapter';
import type { SteeringDecision } from './steering';
import type { Step } from './step';

/** @public Optional lifecycle hooks invoked before and after each step execution. */
export interface AgentHooks {
  beforeStep?: (step: Step, ctx: Context) => Promise<void>;
  afterStep?: (step: Step, result: unknown, ctx: Context) => Promise<void>;
}

/** @public Top-level configuration object that defines an agent's model, tools, memory, and behavior. */
export interface AgentConfig<TParams extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  storage?: StorageAdapter;
  hooks?: AgentHooks;
  params: TParams;
}

//#region Delivery Mode

/** @public How a message submitted during an active turn is delivered to the model.
 *
 *  - `next-turn` (default): queue the message; it becomes a new user turn after
 *    the current turn completes.
 *  - `between-rounds`: inject the message as an additional user item before the
 *    next tool-round LLM call within the same turn. The model sees it partway
 *    through. Mirrors Claude Code's inbox-attachment behaviour.
 *  - `interrupt`: cancel the in-flight LLM stream, append the message, and
 *    restart the turn from the merged history.
 */
export type DeliveryMode = 'next-turn' | 'between-rounds' | 'interrupt';

//#endregion

//#region Base Call Model Request

/** @public Base fields shared by all callModel requests. */
interface CallModelRequestBase {
  model: string;
  items: ReadonlyArray<Item>;
  instructions?: string;
  params?: ModelParams;
  /** When provided, the harness sends a JSON Schema constraint to the model so it returns structured JSON. */
  outputSchema?: ZodType;
  /** Controls framework event emission. Defaults to `true`. Passed through from `StepLLM.emit`. */
  emit?: boolean | ((eventType: string, data: Record<string, unknown>) => boolean);
  /** Optional signal for cancelling the in-flight call (used by session abort). */
  signal?: AbortSignal;
}

/** @public Request shape when tools are provided — ctx is required for tool execution callbacks. */
interface CallModelRequestWithTools extends CallModelRequestBase {
  tools: Tool[];
  ctx: Context;
  layers?: MemoryLayer[];
  /** When set, restricts which tools the model may invoke for this call. */
  allowedToolNames?: string[];
}

/** @public Request shape when no tools are provided — ctx is only needed for tool
 *  execution callbacks in convertTools, so it is omitted here. */
interface CallModelRequestWithoutTools extends CallModelRequestBase {
  tools?: undefined;
  ctx?: undefined;
  layers?: undefined;
}

/** @public Request object for `AgentHarnessContract.callModel()`. Encapsulates all parameters needed for an LLM call using only Noetic types. */
export type CallModelRequest = CallModelRequestWithTools | CallModelRequestWithoutTools;

//#endregion

//#region Execute Options

/** @public Options for `AgentHarness.execute()` to configure the execution context. */
export interface ExecuteOptions {
  threadId?: string;
  resourceId?: string;
  state?: unknown;
  /** Memory layers to apply to the execution context. Overrides harness-level memory if provided. */
  memory?: MemoryLayer[];
  /** Override the harness's default delivery mode for this message only. */
  deliveryMode?: DeliveryMode;
  /**
   * Stable id used for the enqueued message. When provided, this id is emitted
   * in the `turn_started` framework event (`messageIds`), allowing callers to
   * correlate their own UI state (e.g. flipping a `queued` indicator to
   * `sent`) with the message they submitted. A random id is generated when
   * omitted.
   */
  messageId?: string;
}

//#endregion

//#region Harness Status

/** @public Snapshot of a session's runtime state. */
export type HarnessStatus =
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

//#endregion

//#region Session Scope

/** @public Identifies which session the accessor targets. All methods fall back to the harness's default thread when omitted. */
export interface SessionScope {
  threadId?: string;
}

//#endregion

//#region Agent Harness Contract

/** @public Type-level contract for the agent runtime. Used for type annotations throughout the interpreter, memory layers, and context. Implemented by `AgentHarness`. */
export interface AgentHarnessContract<
  TParams extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly config: AgentConfig<TParams>;
  /** Filesystem adapter for virtual or real filesystem access. */
  readonly fs: FsAdapter;
  /** Shell adapter for virtual or real shell command execution. */
  readonly shell: ShellAdapter;
  callModel(request: CallModelRequest): Promise<LLMResponse>;

  /**
   * Submit input to the agent. The message is enqueued on the session identified
   * by `options.threadId` (or the default thread) and processed by the session
   * runner according to the effective `DeliveryMode`.
   *
   * Returns once the message has been accepted into the queue — NOT when the
   * model responds. Use `getAgentResponse()` or `getItemStream()` to observe
   * the response.
   */
  execute(input: ExecuteInput, options?: ExecuteOptions): Promise<void>;

  /**
   * Resolves with the accumulated response once the session has finished
   * processing its queue (status returns to `idle` with no pending messages).
   */
  getAgentResponse(scope?: SessionScope): Promise<HarnessResponse>;

  /** Yields cumulative Item snapshots with isComplete flag across all turns in the session. */
  getItemStream(scope?: SessionScope): AsyncIterable<StreamingItem>;
  /** Yields text deltas as they arrive from the model, across all turns. */
  getTextStream(scope?: SessionScope): AsyncIterable<string>;
  /** Yields reasoning token deltas from reasoning-capable models, across all turns. */
  getReasoningStream(scope?: SessionScope): AsyncIterable<string>;
  /** Yields all raw stream events (SDK + framework) for the session. */
  getFullStream(scope?: SessionScope): AsyncIterable<StreamEvent>;

  /**
   * Cancel the in-flight turn, if any. Queued messages are preserved — the
   * runner re-kicks from the queue once abort completes.
   */
  abort(
    scope?: SessionScope & {
      reason?: string;
    },
  ): Promise<void>;

  /** Current runtime status of a session. */
  getStatus(scope?: SessionScope): HarnessStatus;
  /** Number of messages currently queued on a session. */
  getQueueSize(scope?: SessionScope): number;

  run<I, O>(step: Step<ContextMemory, I, O>, input: I, ctx: Context): Promise<O>;
  detachedSpawn<I, O>(
    step: Step<ContextMemory, I, O>,
    input: I,
    parentCtx: Context,
  ): DetachedHandle<O>;
  createContext(opts?: {
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    memory?: MemoryLayer[];
  }): Context;
  send<T>(channel: Channel<T>, value: T, ctx: Context): void;
  recv<T>(
    channel: Channel<T>,
    ctx: Context,
    opts?: {
      timeout?: number;
    },
  ): Promise<T>;
  tryRecv<T>(channel: Channel<T>, ctx: Context): T | null;
  getChannelHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T>;
  initLayers(layers: MemoryLayer[], ctx: Context, storage: StorageAdapter): Promise<void>;
  recallLayers(layers: MemoryLayer[], input: string, ctx: Context): Promise<RecallLayerOutput[]>;
  storeLayers(layers: MemoryLayer[], response: LLMResponse, ctx: Context): Promise<void>;
  disposeLayers(layers: MemoryLayer[], ctx: Context): Promise<void>;
  checkpoint(ctx: Context): Promise<void>;
  restore(executionId: string): Promise<Context | null>;
  cancel(ctx: Context, reason?: string): Promise<void>;
  createSpan(name: string, parent: Span | null): Span;
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
  /**
   * Run items through the onItemAppend pipeline before appending.
   * Each layer can filter, transform, or inject items.
   * Returns final items to append and any re-render requests.
   */
  runAppendPipeline(
    layers: MemoryLayer[],
    items: Item[],
    ctx: Context,
  ): Promise<AppendPipelineResult>;
  /**
   * Execute re-render based on collected requests.
   * Determines which layers need re-recall based on scope and runs them.
   */
  executeRerender(
    requests: RerenderRequest[],
    layers: MemoryLayer[],
    ctx: Context,
    budgets: Map<string, number>,
    query?: string,
  ): Promise<RecallLayerOutput[]>;
}

//#endregion

/** @public Output from a single memory layer's recall phase, including items and token budget used. */
export interface RecallLayerOutput {
  layerId: string;
  items: Item[];
  tokenCount: number;
}

/** @public A request to re-render the context window, collected from onItemAppend hooks. */
export interface RerenderRequest {
  layerId: string;
  slot: number;
  timing: 'immediate' | 'batched';
  scope: 'self' | 'slot-after' | 'all';
}

/** @public Result of running items through the onItemAppend pipeline. */
export interface AppendPipelineResult {
  /** Final items to append after all transformations. */
  items: Item[];
  /** Re-render requests collected from layers. */
  rerenderRequests: RerenderRequest[];
}
