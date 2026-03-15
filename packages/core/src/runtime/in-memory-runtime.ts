import type { Runtime } from '../types/runtime';
import type { Step } from '../types/step';
import type { Context } from '../types/context';
import type { Item } from '../types/items';
import type { Channel, ExternalChannel, ChannelHandle } from '../types/channel';
import type { MemoryLayer, StorageAdapter } from '../types/memory';
import type { LLMResponse } from '../types/common';
import type { AgentConfig, RecallLayerOutput } from '../types/runtime';
import type { Span } from '../types/observability';
import type { CallModelFn } from '../interpreter/execute-llm';
import { ContextImpl } from './context-impl';
import { execute } from '../interpreter/execute';

export class InMemoryRuntime implements Runtime {
  private callModel?: CallModelFn;

  constructor(opts?: { callModel?: CallModelFn }) {
    this.callModel = opts?.callModel;
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
    return new ContextImpl(opts);
  }

  // Channel operations - stubs for now
  send<T>(channel: Channel<T>, value: T, ctx: Context): void {
    throw new Error('Channels not yet implemented');
  }

  recv<T>(channel: Channel<T>, ctx: Context, opts?: { timeout?: number }): Promise<T> {
    throw new Error('Channels not yet implemented');
  }

  tryRecv<T>(channel: Channel<T>, ctx: Context): T | null {
    throw new Error('Channels not yet implemented');
  }

  getChannelHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T> {
    throw new Error('Channels not yet implemented');
  }

  // Memory layer operations - stubs
  async initLayers(layers: MemoryLayer[], ctx: Context, storage: StorageAdapter): Promise<void> {}
  async recallLayers(layers: MemoryLayer[], input: string, ctx: Context): Promise<RecallLayerOutput[]> { return []; }
  async storeLayers(layers: MemoryLayer[], response: LLMResponse, ctx: Context): Promise<void> {}
  async disposeLayers(layers: MemoryLayer[], ctx: Context): Promise<void> {}

  async assembleView(agent: AgentConfig, input: string, ctx: Context): Promise<Item[]> {
    return [...ctx.itemLog.items];
  }

  async checkpoint(ctx: Context): Promise<void> {}
  async restore(executionId: string): Promise<Context | null> { return null; }
  async cancel(ctx: Context, reason?: string): Promise<void> {}

  createSpan(name: string, parent: Span | null): Span {
    return {
      traceId: crypto.randomUUID(),
      spanId: crypto.randomUUID(),
      parentSpanId: parent?.spanId ?? null,
      setAttribute() {},
      addEvent() {},
      end() {},
    };
  }
}
