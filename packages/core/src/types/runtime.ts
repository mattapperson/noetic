import type { ZodType } from 'zod';
import type { Channel, ChannelHandle, ExternalChannel } from './channel';
import type { LLMResponse, Tool } from './common';
import type { Context } from './context';
import type { DetachedHandle } from './detached';
import type { Item } from './items';
import type { MemoryLayer, ProjectionPolicy, StorageAdapter } from './memory';
import type { Span } from './observability';
import type { SteeringDecision } from './steering';
import type { Step } from './step';

export interface AgentHooks {
  beforeStep?: (step: Step, ctx: Context) => Promise<void>;
  afterStep?: (step: Step, result: unknown, ctx: Context) => Promise<void>;
}

export interface AgentConfig {
  name: string;
  description: string;
  model: string;
  instructions: string | (() => string | Promise<string>);
  tools?: Tool[];
  outputSchema?: ZodType;
  memory?: MemoryLayer[];
  storage?: StorageAdapter;
  projection?: ProjectionPolicy;
  hooks?: AgentHooks;
}

export interface AgentHarness {
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
  assembleView(agent: AgentConfig, input: string, ctx: Context): Promise<Item[]>;
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

export interface RecallLayerOutput {
  layerId: string;
  items: Item[];
  tokenCount: number;
}
