import type { Channel, ChannelHandle, ExternalChannel } from './channel';
import type { LLMResponse } from './common';
import type { Context } from './context';
import type { DetachedHandle } from './detached';
import type { Item } from './items';
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

/** @public Core runtime interface for executing steps, managing channels, and coordinating memory layers. */
export interface AgentHarness<TParams extends Record<string, unknown> = Record<string, unknown>> {
  readonly config: AgentConfig<TParams>;
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

/** @deprecated Use AgentHarness instead. */
export type Runtime = AgentHarness;

/** @public Output from a single memory layer's recall phase, including items and token budget used. */
export interface RecallLayerOutput {
  layerId: string;
  items: Item[];
  tokenCount: number;
}
