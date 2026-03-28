import type { ZodType } from 'zod';
import { getDefaultCallModel } from '../adapters/default-call-model';
import { execute } from '../interpreter/execute';
import type { CallModelFn } from '../interpreter/execute-llm';
import { estimateTokens } from '../interpreter/message-helpers';
import type { LayerStateStore } from '../memory/layer-lifecycle';
import {
  afterModelCallLayers,
  beforeToolCallLayers,
  createLayerStateStore,
  disposeLayers,
  initLayers,
  recallLayers,
  storeLayers,
} from '../memory/layer-lifecycle';
import { SpanImpl } from '../observability/span-impl';
import { NoopExporter } from '../observability/trace-exporter';
import type { Channel, ChannelHandle, ExternalChannel } from '../types/channel';
import type { LLMResponse } from '../types/common';
import type { Context } from '../types/context';
import type { DetachedHandle } from '../types/detached';
import type { Item } from '../types/items';
import type { ExecutionContext, MemoryLayer, StorageAdapter } from '../types/memory';
import type { Span, TraceExporter } from '../types/observability';
import type { AgentConfig, AgentHarness, AgentHooks, RecallLayerOutput } from '../types/runtime';
import type { SteeringDecision } from '../types/steering';
import { SteeringAction } from '../types/steering';
import type { Step } from '../types/step';
import { ChannelStore } from './channel-store';
import { ContextImpl } from './context-impl';
import { DetachedHandleImpl } from './detached-handle';

//#region Types

interface InMemoryAgentHarnessOpts<
  TParams extends Record<string, unknown> = Record<string, unknown>,
> {
  name: string;
  storage?: StorageAdapter;
  hooks?: AgentHooks;
  params: TParams;
  paramsSchema?: ZodType<TParams>;
  callModel?: CallModelFn;
  traceExporter?: TraceExporter;
  layerStateStore?: LayerStateStore;
}

//#endregion

//#region InMemoryAgentHarness

export class InMemoryAgentHarness<TParams extends Record<string, unknown> = Record<string, unknown>>
  implements AgentHarness<TParams>
{
  readonly config: AgentConfig<TParams>;
  private callModel?: CallModelFn;
  private readonly channelStore: ChannelStore;
  readonly layerStateStore: LayerStateStore;
  readonly traceExporter: TraceExporter;

  constructor(opts: InMemoryAgentHarnessOpts<TParams>) {
    const validatedParams = opts.paramsSchema ? opts.paramsSchema.parse(opts.params) : opts.params;

    this.config = {
      name: opts.name,
      storage: opts.storage,
      hooks: opts.hooks,
      params: validatedParams,
    };
    this.callModel = opts.callModel ?? getDefaultCallModel();
    this.channelStore = new ChannelStore();
    this.traceExporter = opts.traceExporter ?? new NoopExporter();
    this.layerStateStore = opts.layerStateStore ?? createLayerStateStore();
  }

  async run<I, O>(step: Step<I, O>, input: I, ctx: Context): Promise<O> {
    return execute(step, input, ctx, this.callModel, this);
  }

  detachedSpawn<I, O>(step: Step<I, O>, input: I, parentCtx: Context): DetachedHandle<O> {
    const childCtx = this.createContext({
      parent: parentCtx,
      threadId: parentCtx.threadId,
      resourceId: parentCtx.resourceId,
    });
    const promise = this.run(step, input, childCtx);
    return new DetachedHandleImpl<O>(childCtx.id, promise);
  }

  createContext(opts?: {
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
  }): Context {
    return new ContextImpl({
      ...opts,
      harness: this,
      channelStore: this.channelStore,
    });
  }

  send<T>(channel: Channel<T>, value: T, _ctx: Context): void {
    this.channelStore.send(channel, value);
  }

  recv<T>(
    channel: Channel<T>,
    _ctx: Context,
    opts?: {
      timeout?: number;
    },
  ): Promise<T> {
    return this.channelStore.recv(channel, opts?.timeout);
  }

  tryRecv<T>(channel: Channel<T>, _ctx: Context): T | null {
    return this.channelStore.tryRecv(channel);
  }

  getChannelHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T> {
    return this.channelStore.getHandle(channel, executionId);
  }

  private toExecCtx(ctx: Context): ExecutionContext {
    return {
      executionId: ctx.id,
      threadId: ctx.threadId,
      resourceId: ctx.resourceId,
      depth: ctx.depth,
      stepNumber: ctx.stepCount,
      tokenUsage: {
        input: ctx.tokens.input,
        output: ctx.tokens.output,
      },
      cost: ctx.cost,
      tokenize: estimateTokens,
      trace: {
        setAttribute: (key, value) => ctx.span.setAttribute(key, value),
        addEvent: (name, attributes) => ctx.span.addEvent(name, attributes),
      },
    };
  }

  async initLayers(layers: MemoryLayer[], ctx: Context, storage: StorageAdapter): Promise<void> {
    await initLayers({
      layers,
      ctx: this.toExecCtx(ctx),
      storage,
      store: this.layerStateStore,
    });
  }

  async recallLayers(
    layers: MemoryLayer[],
    input: string,
    ctx: Context,
  ): Promise<RecallLayerOutput[]> {
    return recallLayers({
      layers,
      query: input,
      ctx: this.toExecCtx(ctx),
      log: ctx.itemLog,
      budgets: new Map(),
      store: this.layerStateStore,
    });
  }

  async storeLayers(layers: MemoryLayer[], response: LLMResponse, ctx: Context): Promise<void> {
    await storeLayers({
      layers,
      response,
      ctx: this.toExecCtx(ctx),
      log: ctx.itemLog,
      store: this.layerStateStore,
    });
  }

  async disposeLayers(layers: MemoryLayer[], ctx: Context): Promise<void> {
    await disposeLayers({
      layers,
      ctx: this.toExecCtx(ctx),
      store: this.layerStateStore,
    });
  }

  async checkpoint(_ctx: Context): Promise<void> {
    // No-op for in-memory harness
  }

  async restore(_executionId: string): Promise<Context | null> {
    return null;
  }
  async cancel(_ctx: Context, _reason?: string): Promise<void> {}

  createSpan(name: string, parent: Span | null): Span {
    return new SpanImpl(name, parent);
  }

  getLayerState<T>(executionId: string, layerId: string): T | undefined {
    return this.layerStateStore.get(executionId, layerId);
  }

  setLayerState<T>(executionId: string, layerId: string, state: T): void {
    this.layerStateStore.set(executionId, layerId, state);
  }

  async beforeToolCall(
    layers: MemoryLayer[],
    toolName: string,
    toolArgs: unknown,
    ctx: Context,
  ): Promise<SteeringDecision> {
    const hasHook = layers.some((l) => l.hooks.beforeToolCall);
    if (!hasHook) {
      return {
        action: SteeringAction.Allow,
      };
    }
    return beforeToolCallLayers({
      layers,
      toolName,
      toolArgs,
      ctx: this.toExecCtx(ctx),
      store: this.layerStateStore,
    });
  }

  async afterModelCall(
    layers: MemoryLayer[],
    response: LLMResponse,
    ctx: Context,
  ): Promise<SteeringDecision> {
    const hasHook = layers.some((l) => l.hooks.afterModelCall);
    if (!hasHook) {
      return {
        action: SteeringAction.Allow,
      };
    }
    return afterModelCallLayers({
      layers,
      response,
      ctx: this.toExecCtx(ctx),
      store: this.layerStateStore,
    });
  }
}

//#endregion

/** @deprecated Use InMemoryAgentHarness instead. */
export const InMemoryRuntime = InMemoryAgentHarness;
