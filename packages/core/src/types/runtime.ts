import type { ZodType } from 'zod';
import type { Channel, ChannelHandle, ExternalChannel } from './channel';
import type { LLMResponse, ModelParams, Tool } from './common';
import type { Context } from './context';
import type { DetachedHandle } from './detached';
import type { FsAdapter } from './fs-adapter';
import type { HarnessResult } from './harness-result';
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

/** @public Options for `AgentHarness.execute()` to configure the execution context. */
export interface ExecuteOptions {
  threadId?: string;
  resourceId?: string;
  state?: unknown;
  /** Memory layers to apply to the execution context. Overrides harness-level memory if provided. */
  memory?: MemoryLayer[];
}

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
  execute(input: ExecuteInput, options?: ExecuteOptions): HarnessResult;
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
