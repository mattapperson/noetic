import { execute } from '../interpreter/execute';
import type { CallModelFn } from '../interpreter/execute-llm';
import type { LayerStateStore } from '../memory/layer-lifecycle';
import {
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
import type { Item } from '../types/items';
import type { ExecutionContext, MemoryLayer, StorageAdapter } from '../types/memory';
import type { Span, TraceExporter } from '../types/observability';
import type { AgentConfig, RecallLayerOutput, Runtime } from '../types/runtime';
import type { Step } from '../types/step';
import { ChannelStore } from './channel-store';
import { ContextImpl } from './context-impl';

export class InMemoryRuntime implements Runtime {
  private callModel?: CallModelFn;
  private readonly channelStore: ChannelStore;
  readonly layerStateStore: LayerStateStore;
  readonly traceExporter: TraceExporter;

  constructor(opts?: {
    callModel?: CallModelFn;
    traceExporter?: TraceExporter;
    layerStateStore?: LayerStateStore;
  }) {
    this.callModel = opts?.callModel;
    this.channelStore = new ChannelStore();
    this.traceExporter = opts?.traceExporter ?? new NoopExporter();
    this.layerStateStore = opts?.layerStateStore ?? createLayerStateStore();
  }

  async execute<I, O>(step: Step<I, O>, input: I, ctx: Context): Promise<O> {
    return execute(step, input, ctx, this.callModel);
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
    };
  }

  async initLayers(layers: MemoryLayer[], ctx: Context, storage: StorageAdapter): Promise<void> {
    await initLayers(layers, this.toExecCtx(ctx), storage, this.layerStateStore);
  }

  async recallLayers(
    layers: MemoryLayer[],
    input: string,
    ctx: Context,
  ): Promise<RecallLayerOutput[]> {
    return recallLayers(
      layers,
      input,
      this.toExecCtx(ctx),
      ctx.itemLog,
      new Map(),
      this.layerStateStore,
    );
  }

  async storeLayers(layers: MemoryLayer[], response: LLMResponse, ctx: Context): Promise<void> {
    await storeLayers(layers, response, this.toExecCtx(ctx), ctx.itemLog, this.layerStateStore);
  }

  async disposeLayers(layers: MemoryLayer[], ctx: Context): Promise<void> {
    await disposeLayers(layers, this.toExecCtx(ctx), this.layerStateStore);
  }

  async assembleView(_agent: AgentConfig, _input: string, ctx: Context): Promise<Item[]> {
    return [
      ...ctx.itemLog.items,
    ];
  }

  async restore(_executionId: string): Promise<Context | null> {
    return null;
  }
  async cancel(_ctx: Context, _reason?: string): Promise<void> {}

  createSpan(name: string, parent: Span | null): Span {
    return new SpanImpl(name, parent);
  }
}
