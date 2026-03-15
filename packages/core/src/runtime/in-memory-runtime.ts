import type { Runtime } from '../types/runtime';
import type { Step } from '../types/step';
import type { Context } from '../types/context';
import type { Item } from '../types/items';
import type { Channel, ExternalChannel, ChannelHandle } from '../types/channel';
import type { MemoryLayer, StorageAdapter } from '../types/memory';
import type { LLMResponse } from '../types/common';
import type { AgentConfig, RecallLayerOutput } from '../types/runtime';
import type { Span, TraceExporter } from '../types/observability';
import type { CallModelFn } from '../interpreter/execute-llm';
import type { LayerStateStore } from '../memory/layer-lifecycle';
import { ContextImpl } from './context-impl';
import { ChannelStore } from './channel-store';
import { execute } from '../interpreter/execute';
import { createLayerStateStore, initLayers, recallLayers, storeLayers, disposeLayers } from '../memory/layer-lifecycle';
import { NoopExporter } from '../observability/trace-exporter';
import { SpanImpl } from '../observability/span-impl';

export class InMemoryRuntime implements Runtime {
  private callModel?: CallModelFn;
  private readonly channelStore: ChannelStore;
  readonly layerStateStore: LayerStateStore;
  readonly traceExporter: TraceExporter;

  constructor(opts?: { callModel?: CallModelFn; traceExporter?: TraceExporter; layerStateStore?: LayerStateStore }) {
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
    return new ContextImpl({ ...opts, channelStore: this.channelStore });
  }

  send<T>(channel: Channel<T>, value: T, _ctx: Context): void {
    this.channelStore.send(channel, value);
  }

  recv<T>(channel: Channel<T>, _ctx: Context, opts?: { timeout?: number }): Promise<T> {
    return this.channelStore.recv(channel, opts?.timeout);
  }

  tryRecv<T>(channel: Channel<T>, _ctx: Context): T | null {
    return this.channelStore.tryRecv(channel);
  }

  getChannelHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T> {
    return this.channelStore.getHandle(channel, executionId);
  }

  async initLayers(layers: MemoryLayer[], ctx: Context, storage: StorageAdapter): Promise<void> {
    const execCtx = { executionId: ctx.id, threadId: ctx.threadId, resourceId: ctx.resourceId, depth: ctx.depth };
    await initLayers(layers, execCtx, storage, this.layerStateStore);
  }

  async recallLayers(layers: MemoryLayer[], input: string, ctx: Context): Promise<RecallLayerOutput[]> {
    const execCtx = { executionId: ctx.id, threadId: ctx.threadId, resourceId: ctx.resourceId, depth: ctx.depth };
    return recallLayers(layers, input, execCtx, ctx.itemLog, new Map(), this.layerStateStore);
  }

  async storeLayers(layers: MemoryLayer[], response: LLMResponse, ctx: Context): Promise<void> {
    const execCtx = { executionId: ctx.id, threadId: ctx.threadId, resourceId: ctx.resourceId, depth: ctx.depth };
    await storeLayers(layers, response, execCtx, ctx.itemLog, this.layerStateStore);
  }

  async disposeLayers(layers: MemoryLayer[], ctx: Context): Promise<void> {
    const execCtx = { executionId: ctx.id, threadId: ctx.threadId, resourceId: ctx.resourceId, depth: ctx.depth };
    await disposeLayers(layers, execCtx, this.layerStateStore);
  }

  async assembleView(agent: AgentConfig, input: string, ctx: Context): Promise<Item[]> {
    return [...ctx.itemLog.items];
  }

  async restore(executionId: string): Promise<Context | null> { return null; }
  async cancel(ctx: Context, reason?: string): Promise<void> {}

  createSpan(name: string, parent: Span | null): Span {
    return new SpanImpl(name, parent);
  }
}
