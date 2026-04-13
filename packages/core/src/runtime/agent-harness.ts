import { OpenRouter } from '@openrouter/agent';
import type { ZodType } from 'zod';
import { z } from 'zod';
import { createLocalFsAdapter } from '../adapters/local-fs-adapter';
import { createLocalShellAdapter } from '../adapters/local-shell-adapter';
import {
  convertTools,
  executeToolCall,
  extractOutputItems,
  extractSystemInstruction,
  extractUsage,
  itemsToInput,
} from '../adapters/openrouter';
import { NoeticConfigError } from '../errors/noetic-config-error';
import { collectAllTools, deduplicateTools } from '../interpreter/collect-tools';
import { execute } from '../interpreter/execute';
import { frameworkCast } from '../interpreter/framework-cast';
import { isFunctionCall } from '../interpreter/typeguards';
import { resolveLayerTools } from '../memory/layer-api';
import type { LayerStateStore } from '../memory/layer-lifecycle';
import {
  afterModelCallLayers,
  beforeToolCallLayers,
  createLayerStateStore,
  disposeLayers,
  executeRerender,
  initLayers,
  recallLayers,
  runAppendPipeline,
  storeLayers,
} from '../memory/layer-lifecycle';
import { SpanImpl } from '../observability/span-impl';
import { NoopExporter } from '../observability/trace-exporter';
import type { Channel, ChannelHandle, ExternalChannel } from '../types/channel';
import type { LLMResponse, LlmProviderConfig, Tool } from '../types/common';
import type { Context } from '../types/context';
import type { DetachedHandle } from '../types/detached';
import type { FsAdapter } from '../types/fs-adapter';
import type { HarnessResult } from '../types/harness-result';
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
import type { ShellAdapter } from '../types/shell-adapter';
import type { SteeringDecision } from '../types/steering';
import { SteeringAction } from '../types/steering';
import type { Step } from '../types/step';
import { emitFrameworkEvent, getBroadcaster, shouldEmit } from './broadcaster-utils';
import { ChannelStore } from './channel-store';
import { ContextImpl } from './context-impl';
import { DetachedHandleImpl } from './detached-handle';
import { EventBroadcaster } from './event-broadcaster';
import { contextToExecCtx } from './exec-context-factory';
import { HarnessResultImpl } from './harness-result';

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
  /** Filesystem adapter. Defaults to local node:fs when not provided. */
  fs?: FsAdapter;
  /** Shell adapter. Defaults to local sh when not provided. */
  shell?: ShellAdapter;
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

function isStreamRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function pipeStreamEventsToBroadcaster(
  stream: AsyncIterable<unknown>,
  broadcaster: EventBroadcaster,
  agentName: string,
): Promise<void> {
  try {
    for await (const event of stream) {
      if (!isStreamRecord(event)) {
        continue;
      }
      broadcaster.emit({
        source: 'sdk',
        type: typeof event.type === 'string' ? event.type : 'unknown',
        data: event,
        outputIndex: typeof event.outputIndex === 'number' ? event.outputIndex : undefined,
        contentIndex: typeof event.contentIndex === 'number' ? event.contentIndex : undefined,
      });
    }
  } catch (err: unknown) {
    emitFrameworkEvent({
      broadcaster,
      agentName,
      eventType: 'stream_pipe_error',
      data: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
    // Re-throw so pipePromise rejects and the error propagates
    // through the execution promise to broadcaster.error().
    throw err;
  }
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
  readonly fs: FsAdapter;
  readonly shell: ShellAdapter;
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
    this.fs = opts.fs ?? createLocalFsAdapter();
    this.shell = opts.shell ?? createLocalShellAdapter();
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

    const { instructions: extractedInstructions, remaining } = extractSystemInstruction(
      request.items,
    );
    const instructions =
      [
        request.instructions,
        extractedInstructions,
      ]
        .filter(Boolean)
        .join('\n\n') || undefined;
    const broadcaster = getBroadcaster(request.ctx);
    const agentName = this.config.name;

    /** Emit a framework event, respecting request.emit filter. */
    const emitIfAllowed = (eventType: string, data: Record<string, unknown>): void => {
      if (shouldEmit(request.emit, eventType, data)) {
        emitFrameworkEvent({
          broadcaster,
          agentName,
          eventType,
          data,
        });
      }
    };

    // Filter tools to allowed names when per-step restriction is set.
    // The OpenRouter API doesn't support an 'allowed_tools' toolChoice type,
    // so we filter the tools array instead to achieve the same restriction.
    const allowedNamesSet =
      request.tools && 'allowedToolNames' in request && request.allowedToolNames
        ? new Set(request.allowedToolNames)
        : undefined;
    const filteredTools = allowedNamesSet
      ? request.tools?.filter((t) => allowedNamesSet.has(t.name))
      : request.tools;

    let sdkTools: ReturnType<typeof convertTools> | undefined;
    if (filteredTools && filteredTools.length > 0) {
      sdkTools = convertTools({
        tools: filteredTools,
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

      // The OpenRouter SDK internally tees the HTTP stream, so
      // getFullResponsesStream() and getResponse() can be consumed
      // concurrently. Events flow to the broadcaster in real-time while
      // getResponse() accumulates the final result independently.
      // `await pipePromise` ensures all events are emitted before
      // proceeding to tool-round processing.
      const pipePromise = broadcaster
        ? pipeStreamEventsToBroadcaster(callResult.getFullResponsesStream(), broadcaster, agentName)
        : undefined;

      const sdkResponse = await callResult.getResponse();
      await pipePromise;
      const roundItems = extractOutputItems(sdkResponse);
      const roundUsage = extractUsage(sdkResponse.usage);

      totalUsage.inputTokens += roundUsage.inputTokens;
      totalUsage.outputTokens += roundUsage.outputTokens;
      totalUsage.cachedTokens += roundUsage.cachedTokens ?? 0;
      totalCost += sdkResponse.usage?.cost ?? 0;

      allItems.push(...roundItems);

      const functionCalls = roundItems.filter(isFunctionCall);
      if (functionCalls.length === 0 || !request.tools) {
        break;
      }

      // Emit tool round framework event
      emitIfAllowed('tool_round_started', {
        round,
        toolCount: functionCalls.length,
      });

      // Add function calls to conversation, then execute and append results
      for (const fc of functionCalls) {
        conversationInput.push({
          type: 'function_call',
          callId: fc.callId,
          id: fc.id ?? crypto.randomUUID(),
          name: fc.name,
          arguments: fc.arguments,
        });
      }

      for (const fc of functionCalls) {
        emitIfAllowed('tool_call_started', {
          name: fc.name,
          callId: fc.callId,
        });

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
          emitIfAllowed('tool_call_completed', {
            name: fc.name,
            callId: fc.callId,
            error: true,
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

        emitIfAllowed('tool_call_completed', {
          name: fc.name,
          callId: fc.callId,
          error: false,
        });
      }

      emitIfAllowed('tool_round_completed', {
        round,
        toolCount: functionCalls.length,
      });
    }

    return {
      items: allItems,
      usage: totalUsage,
      cost: totalCost > 0 ? totalCost : undefined,
    };
  }

  execute(input: ExecuteInput, options?: ExecuteOptions): HarnessResult {
    if (!this.initialStep) {
      return HarnessResultImpl.fromError(
        new NoeticConfigError({
          code: 'NO_STEP_CONFIGURED',
          message: 'No initialStep configured on this harness.',
          hint: 'Pass `initialStep` in constructor options, or use run() directly.',
        }),
      );
    }

    // Collect all tools from the step tree for unified tool set
    const stepTools = collectAllTools(this.initialStep);

    const broadcaster = new EventBroadcaster();

    let executionPromise: Promise<string>;
    let ctx: Context;

    if (typeof input === 'string') {
      ctx = this.createContext({
        ...options,
        _broadcaster: broadcaster,
      });
      // Resolve layer tools now that ctx exists, then build unified set
      this.setUnifiedTools(ctx, stepTools);
      executionPromise = this.run(this.initialStep, input, ctx);
    } else {
      const items = Array.isArray(input)
        ? input
        : [
            input,
          ];
      ctx = this.createContext({
        items,
        ...options,
        _broadcaster: broadcaster,
      });
      this.setUnifiedTools(ctx, stepTools);
      executionPromise = this.run(this.initialStep, '', ctx);
    }

    // Complete broadcaster when execution finishes
    executionPromise.then(
      () => broadcaster.complete(),
      (err: unknown) => broadcaster.error(err instanceof Error ? err : new Error(String(err))),
    );

    return new HarnessResultImpl(broadcaster, executionPromise, ctx);
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
    _broadcaster?: EventBroadcaster;
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

  /** Resolves layer-provided tools and merges with step tools into ctx.unifiedTools. */
  private setUnifiedTools(ctx: Context, stepTools: Tool[]): void {
    const layers = ctx.layers;
    const layerTools = layers && layers.length > 0 ? resolveLayerTools(layers, this, ctx) : [];
    const allTools = deduplicateTools([
      ...stepTools,
      ...layerTools,
    ]);
    if (allTools.length > 0) {
      // Set unifiedTools after construction since resolveLayerTools requires a context reference.
      // The Context interface is readonly but ContextImpl is mutable.
      const impl = frameworkCast<{
        unifiedTools: ReadonlyArray<Tool>;
      }>(ctx);
      impl.unifiedTools = allTools;
    }
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

  async runAppendPipeline(
    layers: MemoryLayer[],
    items: Item[],
    ctx: Context,
  ): Promise<{
    items: Item[];
    rerenderRequests: {
      layerId: string;
      slot: number;
      timing: 'immediate' | 'batched';
      scope: 'self' | 'slot-after' | 'all';
    }[];
  }> {
    const hasHook = layers.some((l) => l.hooks.onItemAppend);
    if (!hasHook) {
      return {
        items,
        rerenderRequests: [],
      };
    }
    return runAppendPipeline({
      layers,
      items,
      ctx: this.toExecCtx(ctx),
      log: ctx.itemLog,
      store: this.layerStateStore,
    });
  }

  async executeRerender(
    requests: {
      layerId: string;
      slot: number;
      timing: 'immediate' | 'batched';
      scope: 'self' | 'slot-after' | 'all';
    }[],
    layers: MemoryLayer[],
    ctx: Context,
    budgets: Map<string, number>,
    query?: string,
  ): Promise<
    {
      layerId: string;
      items: Item[];
      tokenCount: number;
    }[]
  > {
    return executeRerender({
      requests,
      layers,
      ctx: this.toExecCtx(ctx),
      log: ctx.itemLog,
      budgets,
      store: this.layerStateStore,
      query,
    });
  }
}

//#endregion
