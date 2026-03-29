import type { ZodType } from 'zod';
import type { Channel, ChannelHandle, ExternalChannel } from './channel';
import type { LLMResponse, ModelParams, Tool } from './common';
import type { Context } from './context';
import type { DetachedHandle } from './detached';
import type { ExecuteInput, Item } from './items';
import type { MemoryLayer, StorageAdapter } from './memory';
import type { Span } from './observability';
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
  params?: ModelParams;
  /** When provided, the harness sends a JSON Schema constraint to the model so it returns structured JSON. */
  outputSchema?: ZodType;
}

/** @public Request shape when tools are provided — ctx is required for tool execution callbacks. */
interface CallModelRequestWithTools extends CallModelRequestBase {
  tools: Tool[];
  ctx: Context;
  layers?: MemoryLayer[];
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
}

/** @public Type-level contract for the agent runtime. Used for type annotations throughout the interpreter, memory layers, and context. Implemented by `AgentHarness`. */
export interface AgentHarnessContract<
  TParams extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly config: AgentConfig<TParams>;
  callModel(request: CallModelRequest): Promise<LLMResponse>;
  execute(input: ExecuteInput, options?: ExecuteOptions): Promise<string>;
  run<I, O>(step: Step<I, O>, input: I, ctx: Context): Promise<O>;
  detachedSpawn<I, O>(step: Step<I, O>, input: I, parentCtx: Context): DetachedHandle<O>;
  createContext(opts?: {
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
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
}

/** @public Output from a single memory layer's recall phase, including items and token budget used. */
export interface RecallLayerOutput {
  layerId: string;
  items: Item[];
  tokenCount: number;
}
