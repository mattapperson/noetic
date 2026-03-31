import { OpenRouter } from '@openrouter/sdk';
import type { ZodType } from 'zod';
import { z } from 'zod';
import {
  convertTools,
  executeToolCall,
  extractSystemInstruction,
  extractUsage,
  itemsToInput,
  responseToNoeticItems,
} from '../adapters/openrouter';
import { NoeticConfigError } from '../errors/noetic-config-error';
import { execute } from '../interpreter/execute';
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
import type { LLMResponse, LlmProviderConfig } from '../types/common';
import type { Context } from '../types/context';
import type { DetachedHandle } from '../types/detached';
import type { ExecuteInput, Item } from '../types/items';
import type { ContextMemory, ExecutionContext, MemoryLayer, StorageAdapter } from '../types/memory';
import type { Span, TraceExporter } from '../types/observability';
import type {
  AgentConfig,
  AgentHarnessContract,
  AgentHooks,
  CallModelRequest,
  ExecuteOptions,
  RecallLayerOutput,
} from '../types/runtime';
import type { SteeringDecision } from '../types/steering';
import { SteeringAction } from '../types/steering';
import type { Step } from '../types/step';
import { ChannelStore } from './channel-store';
import { ContextImpl } from './context-impl';
import { DetachedHandleImpl } from './detached-handle';
import { contextToExecCtx } from './exec-context-factory';

//#region Types

interface AgentHarnessOpts<TParams extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  initialStep?: Step<ContextMemory, string, string>;
  /** Default memory layers applied to every context created via `createContext()` / `execute()`. */
  memory?: MemoryLayer[];
  storage?: StorageAdapter;
  hooks?: AgentHooks;
  params: TParams;
  paramsSchema?: ZodType<TParams>;
  llm?: LlmProviderConfig;
  traceExporter?: TraceExporter;
  layerStateStore?: LayerStateStore;
  /** @internal Test-only escape hatch to inject a mock callModel implementation. */
  _testCallModel?: (request: CallModelRequest) => Promise<LLMResponse>;
}

//#endregion

const MAX_TOOL_ROUNDS = 32;

//#region Helpers

function createClient(config?: LlmProviderConfig): OpenRouter | undefined {
  const apiKey = config?.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return undefined;
  }
  return new OpenRouter({
    apiKey,
  });
}

function buildTextFormat(schema: ZodType): {
  format: {
    type: 'json_schema';
    name: string;
    schema: Record<string, unknown>;
  };
} {
  const jsonSchema = z.toJSONSchema(schema);
  return {
    format: {
      type: 'json_schema',
      name: 'output',
      schema: jsonSchema,
    },
  };
}

//#endregion

//#region AgentHarness

/**
 * Default agent harness for executing agent steps with built-in channel, memory, and trace support.
 * Provides channel store, memory layer lifecycle, and trace export with no external dependencies.
 *
 * @public
 */
export class AgentHarness<TParams extends Record<string, unknown> = Record<string, unknown>>
  implements AgentHarnessContract<TParams>
{
  readonly config: AgentConfig<TParams>;
  private readonly initialStep?: Step<ContextMemory, string, string>;
  private readonly _memory?: MemoryLayer[];
  private readonly client?: OpenRouter;
  private readonly channelStore: ChannelStore;
  private readonly callModelOverride?: (request: CallModelRequest) => Promise<LLMResponse>;
  readonly layerStateStore: LayerStateStore;
  readonly traceExporter: TraceExporter;

  constructor(opts: AgentHarnessOpts<TParams>) {
    const validatedParams = opts.paramsSchema ? opts.paramsSchema.parse(opts.params) : opts.params;

    this.config = {
      name: opts.name,
      storage: opts.storage,
      hooks: opts.hooks,
      params: validatedParams,
    };
    this.initialStep = opts.initialStep;
    this._memory = opts.memory;
    this.callModelOverride = opts._testCallModel;
    this.client = opts._testCallModel ? undefined : createClient(opts.llm);
    this.channelStore = new ChannelStore();
    this.traceExporter = opts.traceExporter ?? new NoopExporter();
    this.layerStateStore = opts.layerStateStore ?? createLayerStateStore();
  }

  async callModel(request: CallModelRequest): Promise<LLMResponse> {
    if (this.callModelOverride) {
      return this.callModelOverride(request);
    }

    if (!this.client) {
      throw new NoeticConfigError({
        code: 'NO_LLM_PROVIDER',
        message: 'No LLM provider configured on this harness.',
        hint: 'Pass `llm: { provider: "openrouter", apiKey: "..." }` in constructor options or set OPENROUTER_API_KEY.',
      });
    }

    const { instructions, remaining } = extractSystemInstruction(request.items);

    let sdkTools: ReturnType<typeof convertTools> | undefined;
    if (request.tools && request.tools.length > 0) {
      sdkTools = convertTools({
        tools: request.tools,
      });
    }

    const allItems: Item[] = [];
    const totalUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    };
    let totalCost = 0;

    const conversationInput = itemsToInput(remaining);
    const textFormat = request.outputSchema ? buildTextFormat(request.outputSchema) : undefined;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const callResult = this.client.callModel({
        model: request.model,
        input: conversationInput,
        instructions,
        tools: sdkTools,
        temperature: request.params?.temperature,
        maxOutputTokens: request.params?.maxTokens,
        topP: request.params?.topP,
        ...(textFormat
          ? {
              text: textFormat,
            }
          : {}),
      });

      const sdkResponse = await callResult.getResponse();
      const roundItems = responseToNoeticItems(sdkResponse);
      const roundUsage = extractUsage(sdkResponse.usage);

      totalUsage.inputTokens += roundUsage.inputTokens;
      totalUsage.outputTokens += roundUsage.outputTokens;
      totalUsage.cachedTokens += roundUsage.cachedTokens ?? 0;
      totalCost += sdkResponse.usage?.cost ?? 0;

      allItems.push(...roundItems);

      const functionCalls = roundItems.filter((item) => item.type === 'function_call');
      if (functionCalls.length === 0 || !request.tools) {
        break;
      }

      // Add function calls to conversation, then execute and append results
      for (const fc of functionCalls) {
        conversationInput.push({
          type: 'function_call',
          callId: fc.callId,
          id: fc.id,
          name: fc.name,
          arguments: fc.arguments,
        });
      }

      for (const fc of functionCalls) {
        let parsedArgs: unknown;
        try {
          parsedArgs = JSON.parse(fc.arguments);
        } catch {
          const errorOutput = `Error: malformed JSON in tool arguments: ${fc.arguments}`;
          allItems.push({
            id: crypto.randomUUID(),
            status: 'completed',
            type: 'function_call_output',
            callId: fc.callId,
            output: errorOutput,
          });
          conversationInput.push({
            type: 'function_call_output',
            callId: fc.callId,
            output: errorOutput,
          });
          continue;
        }

        const output = await executeToolCall({
          toolName: fc.name,
          args: parsedArgs,
          tools: request.tools,
          context: request.ctx,
          harness: this,
          layers: request.layers,
        });

        allItems.push({
          id: crypto.randomUUID(),
          status: 'completed',
          type: 'function_call_output',
          callId: fc.callId,
          output,
        });
        conversationInput.push({
          type: 'function_call_output',
          callId: fc.callId,
          output,
        });
      }
    }

    return {
      items: allItems,
      usage: totalUsage,
      cost: totalCost > 0 ? totalCost : undefined,
    };
  }

  async execute(input: ExecuteInput, options?: ExecuteOptions): Promise<string> {
    if (!this.initialStep) {
      throw new NoeticConfigError({
        code: 'NO_STEP_CONFIGURED',
        message: 'No initialStep configured on this harness.',
        hint: 'Pass `initialStep` in constructor options, or use run() directly.',
      });
    }

    if (typeof input === 'string') {
      const ctx = this.createContext(options);
      return this.run(this.initialStep, input, ctx);
    }

    const items = Array.isArray(input)
      ? input
      : [
          input,
        ];
    const ctx = this.createContext({
      items,
      ...options,
    });
    return this.run(this.initialStep, '', ctx);
  }

  async run<I, O>(s: Step<ContextMemory, I, O>, input: I, ctx: Context): Promise<O> {
    return execute(s, input, ctx);
  }

  detachedSpawn<I, O>(
    s: Step<ContextMemory, I, O>,
    input: I,
    parentCtx: Context,
  ): DetachedHandle<O> {
    const childCtx = this.createContext({
      parent: parentCtx,
      threadId: parentCtx.threadId,
      resourceId: parentCtx.resourceId,
    });
    const promise = this.run(s, input, childCtx);
    return new DetachedHandleImpl<O>(childCtx.id, promise);
  }

  createContext(opts?: {
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    memory?: MemoryLayer[];
  }): Context {
    const { memory: memoryLayers, ...rest } = opts ?? {};
    return new ContextImpl({
      ...rest,
      harness: this,
      channelStore: this.channelStore,
      layers: memoryLayers ?? this._memory,
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
    return contextToExecCtx(ctx, (request) => this.callModel(request));
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
