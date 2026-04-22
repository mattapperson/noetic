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
  resolveLayerBudgets,
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
import type { HarnessResponse, StreamEvent, StreamingItem } from '../types/harness-result';
import type { ExecuteInput, InputMessageItem, Item } from '../types/items';
import type { ContextMemory, ExecutionContext, MemoryLayer, StorageAdapter } from '../types/memory';
import type { Span, TraceExporter } from '../types/observability';
import type {
  AgentConfig,
  AgentHarnessContract,
  AgentHooks,
  CallModelRequest,
  DeliveryMode,
  ExecuteOptions,
  HarnessStatus,
  RecallLayerOutput,
  SessionScope,
} from '../types/runtime';
import type { ShellAdapter } from '../types/shell-adapter';
import type { SteeringDecision } from '../types/steering';
import { SteeringAction } from '../types/steering';
import type { Step } from '../types/step';
import { emitFrameworkEvent, getBroadcaster, shouldEmit } from './broadcaster-utils';
import { ChannelStore } from './channel-store';
import { ContextImpl } from './context-impl';
import { DetachedHandleImpl } from './detached-handle';
import type { EventBroadcaster } from './event-broadcaster';
import { contextToExecCtx } from './exec-context-factory';
import { createInMemoryStorage } from './in-memory-storage';
import type { MessageQueue, QueuedMessage } from './message-queue';
import { SessionRunner } from './session-runner';
import { buildItemStream, filterReasoningStream, filterTextStream } from './session-streams';

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
  /** Default delivery mode for messages that don't specify one. Defaults to `next-turn`. */
  defaultDeliveryMode?: DeliveryMode;
  /**
   * Abort the in-flight model call if the provider stream emits no events for this
   * many milliseconds. Defaults to `DEFAULT_STREAM_IDLE_TIMEOUT_MS` (120s).
   * Pass `0` or a negative number to disable the watchdog.
   */
  streamIdleTimeoutMs?: number;
  /** @internal Test-only escape hatch to inject a mock callModel implementation. */
  _testCallModel?: (request: CallModelRequest) => Promise<LLMResponse>;
}

interface Session {
  readonly runner: SessionRunner;
  accumulatedItems: Item[];
}

//#endregion

const MAX_TOOL_ROUNDS = 32;
const DEFAULT_THREAD_ID = '__default__';
/** Default idle-timeout for a single model call's streaming response. Chosen to be
 *  long enough that slow models aren't falsely aborted, but short enough that a
 *  stalled SSE becomes a visible error rather than a silent hang. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120e3;

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

/** Race a promise against an AbortSignal so callers (e.g. `SessionRunner.abort`)
 *  can break out of a long `await` without waiting for the underlying call to
 *  settle. When the signal fires, the returned promise rejects with
 *  `signal.reason` (an `Error`) or a generic `Error('aborted')` fallback. */
function awaitWithAbort<T>(p: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return p;
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, {
      once: true,
    });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

interface PipeStreamOpts {
  stream: AsyncIterable<unknown>;
  /** Optional: when provided, each SDK event is emitted into it. Absent in
   *  headless/test harness runs that still need the idle watchdog to reset. */
  broadcaster?: EventBroadcaster;
  agentName: string;
  signal?: AbortSignal;
  /** Invoked once per SDK event received — used by the idle watchdog to bump
   *  its deadline so a still-streaming response isn't aborted. */
  onEvent?: () => void;
}

async function pipeStreamEventsToBroadcaster(opts: PipeStreamOpts): Promise<void> {
  const { stream, broadcaster, agentName, signal, onEvent } = opts;
  try {
    for await (const event of stream) {
      if (signal?.aborted) {
        return;
      }
      onEvent?.();
      if (!isStreamRecord(event)) {
        continue;
      }
      broadcaster?.emit({
        source: 'sdk',
        type: typeof event.type === 'string' ? event.type : 'unknown',
        data: event,
        outputIndex: typeof event.outputIndex === 'number' ? event.outputIndex : undefined,
        contentIndex: typeof event.contentIndex === 'number' ? event.contentIndex : undefined,
      });
    }
  } catch (err: unknown) {
    if (broadcaster) {
      emitFrameworkEvent({
        broadcaster,
        agentName,
        eventType: 'stream_pipe_error',
        data: {
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
    throw err;
  }
}

interface StreamIdleWatchdog {
  /** Bump the deadline because a stream event just arrived. */
  reset: () => void;
  /** Clear the pending timer. Safe to call multiple times. */
  stop: () => void;
}

/** @internal Create a watchdog that aborts `controller` when no
 *  {@link StreamIdleWatchdog.reset reset} is called within `timeoutMs`. When
 *  `timeoutMs <= 0`, returns an inert no-op so callers can always call `.reset()`
 *  / `.stop()` without a branch. Starts armed: the caller is responsible for
 *  `.stop()` in a `finally`. `onTimeout` runs before the abort so observers can
 *  emit a framework event with the original cause. Exported only for unit tests. */
export function createStreamIdleWatchdog(
  timeoutMs: number,
  controller: AbortController,
  onTimeout?: () => void,
): StreamIdleWatchdog {
  if (timeoutMs <= 0) {
    return {
      reset: () => {},
      stop: () => {},
    };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const arm = (): void => {
    timer = setTimeout(() => {
      if (stopped) {
        return;
      }
      const reason = new Error(`llm stream idle timeout after ${timeoutMs}ms`);
      onTimeout?.();
      controller.abort(reason);
    }, timeoutMs);
  };
  arm();
  return {
    reset: () => {
      if (stopped || !timer) {
        return;
      }
      clearTimeout(timer);
      arm();
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

/** @internal Context carries the session queue reference so callModel can
 *  inject between-rounds messages into the current tool-round loop. */
interface SessionCtxExtension {
  _sessionQueue?: MessageQueue;
  _sessionBetweenRounds?: boolean;
  _sessionRunnerAgentName?: string;
}

function hasSessionQueue(ctx: Context): ctx is Context & Required<SessionCtxExtension> {
  const maybe = frameworkCast<Context & SessionCtxExtension>(ctx);
  return (
    maybe._sessionBetweenRounds === true &&
    maybe._sessionQueue !== undefined &&
    typeof maybe._sessionRunnerAgentName === 'string'
  );
}

//#endregion

//#region AgentHarness

/**
 * Default agent harness for executing agent steps with built-in channel, memory, and trace support.
 * Provides channel store, memory layer lifecycle, and trace export with no external dependencies.
 *
 * Messages submitted via `execute()` are enqueued on a per-thread session and
 * processed by a `SessionRunner`. Consumers observe responses via the session-
 * scoped accessors: `getAgentResponse`, `getItemStream`, etc.
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
  private readonly defaultDeliveryMode: DeliveryMode;
  private readonly streamIdleTimeoutMs: number;
  private readonly sessions = new Map<string, Session>();
  readonly layerStateStore: LayerStateStore;
  readonly traceExporter: TraceExporter;

  constructor(opts: AgentHarnessOpts<TParams>) {
    const validatedParams = opts.paramsSchema ? opts.paramsSchema.parse(opts.params) : opts.params;

    this.config = {
      name: opts.name,
      storage: opts.storage ?? createInMemoryStorage(),
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
    this.defaultDeliveryMode = opts.defaultDeliveryMode ?? 'next-turn';
    this.streamIdleTimeoutMs = opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  }

  //#region Session Accessors

  execute(input: ExecuteInput, options?: ExecuteOptions): Promise<void> {
    if (!this.initialStep) {
      return Promise.reject(
        new NoeticConfigError({
          code: 'NO_STEP_CONFIGURED',
          message: 'No initialStep configured on this harness.',
          hint: 'Pass `initialStep` in constructor options, or use run() directly.',
        }),
      );
    }

    const threadId = options?.threadId ?? DEFAULT_THREAD_ID;
    const deliveryMode = options?.deliveryMode ?? this.defaultDeliveryMode;
    const session = this.getOrCreateSession(threadId);
    const message: QueuedMessage = {
      id: options?.messageId ?? `msg-${crypto.randomUUID()}`,
      input,
      deliveryMode,
      options: options ?? {},
      enqueuedAt: Date.now(),
    };

    if (deliveryMode === 'interrupt' && session.runner.getStatus().kind === 'generating') {
      session.runner.queue.prepend(message);
      // Abort kicks the runner via queue subscription after the in-flight turn settles.
      void session.runner.abort('interrupt');
      return Promise.resolve();
    }

    session.runner.queue.enqueue(message);
    return Promise.resolve();
  }

  getAgentResponse(scope?: SessionScope): Promise<HarnessResponse> {
    const session = this.requireSession(scope);
    return session.runner.getAgentResponse();
  }

  getItemStream(scope?: SessionScope): AsyncIterable<StreamingItem> {
    const session = this.requireSession(scope);
    return buildItemStream(session.runner.broadcaster);
  }

  getTextStream(scope?: SessionScope): AsyncIterable<string> {
    const session = this.requireSession(scope);
    return filterTextStream(session.runner.broadcaster);
  }

  getReasoningStream(scope?: SessionScope): AsyncIterable<string> {
    const session = this.requireSession(scope);
    return filterReasoningStream(session.runner.broadcaster);
  }

  getFullStream(scope?: SessionScope): AsyncIterable<StreamEvent> {
    const session = this.requireSession(scope);
    return session.runner.broadcaster;
  }

  async abort(
    scope?: SessionScope & {
      reason?: string;
    },
  ): Promise<void> {
    const threadId = scope?.threadId ?? DEFAULT_THREAD_ID;
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }
    await session.runner.abort(scope?.reason);
  }

  getStatus(scope?: SessionScope): HarnessStatus {
    const threadId = scope?.threadId ?? DEFAULT_THREAD_ID;
    const session = this.sessions.get(threadId);
    if (!session) {
      return {
        kind: 'idle',
      };
    }
    return session.runner.getStatus();
  }

  getQueueSize(scope?: SessionScope): number {
    const threadId = scope?.threadId ?? DEFAULT_THREAD_ID;
    const session = this.sessions.get(threadId);
    return session ? session.runner.queue.size : 0;
  }

  private getOrCreateSession(threadId: string): Session {
    const existing = this.sessions.get(threadId);
    if (existing) {
      return existing;
    }

    const session: Session = {
      accumulatedItems: [],
      runner: new SessionRunner({
        threadId,
        agentName: this.config.name,
        // The first queued message in a batch establishes `resourceId` /
        // `state` / `memory` for the turn. If multiple messages are drained
        // together (queue flush), later messages' values for these fields
        // are ignored. `deliveryMode` is resolved per-message at enqueue
        // time and doesn't apply here.
        createContext: (items, _turnId, messages) => {
          const perTurnOptions: ExecuteOptions = messages[0]?.options ?? {};
          const allItems: Item[] = [
            ...session.accumulatedItems,
            ...items,
          ];
          const ctx = this.createContext({
            items: allItems,
            threadId,
            resourceId: perTurnOptions.resourceId,
            state: perTurnOptions.state,
            memory: perTurnOptions.memory,
            _broadcaster: session.runner.broadcaster,
          });
          const ext = frameworkCast<Context & SessionCtxExtension>(ctx);
          ext._sessionQueue = session.runner.queue;
          ext._sessionBetweenRounds = true;
          ext._sessionRunnerAgentName = this.config.name;
          if (this.initialStep) {
            this.setUnifiedTools(ctx, collectAllTools(this.initialStep));
          }
          return ctx;
        },
        runTurn: async (ctx, _turn, signal) => {
          if (!this.initialStep) {
            throw new NoeticConfigError({
              code: 'NO_STEP_CONFIGURED',
              message: 'No initialStep configured on this harness.',
              hint: 'Pass `initialStep` in constructor options.',
            });
          }
          // Wire signal-abort to context-abort so the interpreter bails cleanly.
          if (signal.aborted) {
            ctx.abort(signal.reason ? String(signal.reason) : 'aborted');
          } else {
            signal.addEventListener(
              'abort',
              () => {
                ctx.abort(signal.reason ? String(signal.reason) : 'aborted');
              },
              {
                once: true,
              },
            );
          }
          const result = await this.initAndRun(this.initialStep, '', ctx);
          // Snapshot final items into session history for the next turn.
          session.accumulatedItems = [
            ...ctx.itemLog.items,
          ];
          return result;
        },
      }),
    };

    this.sessions.set(threadId, session);
    return session;
  }

  private requireSession(scope: SessionScope | undefined): Session {
    const threadId = scope?.threadId ?? DEFAULT_THREAD_ID;
    let session = this.sessions.get(threadId);
    if (session) {
      return session;
    }
    // Lazily create so consumers can attach stream listeners before the first execute.
    session = this.getOrCreateSession(threadId);
    return session;
  }

  //#endregion

  //#region callModel

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
    const signal = request.signal;

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
      if (signal?.aborted) {
        break;
      }

      // Inject between-rounds inbox messages (mode: 'between-rounds') before
      // the next LLM call. Mirrors Claude Code's teammate-attachment path.
      // Also append to ctx.itemLog so the session's post-turn snapshot
      // carries the injected messages into next turn's history.
      if (round > 0 && request.ctx && hasSessionQueue(request.ctx)) {
        const injected = this.drainBetweenRoundsMessages(request.ctx._sessionQueue);
        if (injected.length > 0) {
          for (const msg of injected) {
            const text = itemToText(msg);
            const userItem: InputMessageItem = {
              id: `user-${crypto.randomUUID()}`,
              type: 'message',
              role: 'user',
              status: 'completed',
              content: [
                {
                  type: 'input_text',
                  text,
                },
              ],
            };
            conversationInput.push({
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text,
                },
              ],
            });
            request.ctx.itemLog.append(userItem);
          }
          emitIfAllowed('inbox_injected', {
            round,
            count: injected.length,
            messageIds: injected.map((i) => i.id),
          });
        }
      }

      // Build a round-scoped controller that also aborts when the caller's
      // signal fires — `AbortSignal.any` handles listener lifecycle for us
      // (no manual cleanup required on normal completion).
      const roundController = new AbortController();
      const roundSignal = signal
        ? AbortSignal.any([
            signal,
            roundController.signal,
          ])
        : roundController.signal;
      let firstEventSeen = false;
      let idleStalled = false;
      const watchdog = createStreamIdleWatchdog(this.streamIdleTimeoutMs, roundController, () => {
        idleStalled = true;
        emitIfAllowed('llm_call_stalled', {
          round,
          idleTimeoutMs: this.streamIdleTimeoutMs,
        });
      });

      emitIfAllowed('llm_call_started', {
        round,
        messageCount: conversationInput.length,
        toolCount: sdkTools?.length ?? 0,
      });

      const callResult = this.client.callModel(
        {
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
        },
        {
          signal: roundSignal,
        },
      );

      const onStreamEvent = (): void => {
        watchdog.reset();
        if (!firstEventSeen) {
          firstEventSeen = true;
          emitIfAllowed('llm_call_first_event', {
            round,
          });
        }
      };

      // Always consume the SDK stream so the watchdog gets reset per event
      // even when no broadcaster is attached (headless / test harness runs).
      // Emission into the broadcaster is optional inside the pipe function.
      const pipePromise = pipeStreamEventsToBroadcaster({
        stream: callResult.getFullResponsesStream(),
        broadcaster,
        agentName,
        signal: roundSignal,
        onEvent: onStreamEvent,
      });

      let sdkResponse: Awaited<ReturnType<typeof callResult.getResponse>>;
      try {
        sdkResponse = await awaitWithAbort(callResult.getResponse(), roundSignal);
        // Stop the watchdog synchronously the instant the response resolves,
        // closing the race where a pending setTimeout could fire in the
        // microtask gap between this await and the `finally` below.
        watchdog.stop();
        await awaitWithAbort(pipePromise, roundSignal);
      } catch (err: unknown) {
        if (idleStalled) {
          // roundSignal.reason is the Error the watchdog passed to controller.abort().
          throw roundSignal.reason instanceof Error
            ? roundSignal.reason
            : new Error(`llm stream idle timeout after ${this.streamIdleTimeoutMs}ms`);
        }
        // Parent signal cancelled the round — exit gracefully rather than
        // propagating the abort error as an exception.
        if (signal?.aborted) {
          break;
        }
        throw err;
      } finally {
        watchdog.stop();
      }
      if (signal?.aborted) {
        break;
      }
      emitIfAllowed('llm_call_completed', {
        round,
        itemCount: sdkResponse.output?.length ?? 0,
      });
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

      emitIfAllowed('tool_round_started', {
        round,
        toolCount: functionCalls.length,
      });

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
        if (signal?.aborted) {
          break;
        }
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

  /** @internal Drain only messages tagged `between-rounds` from the queue. */
  private drainBetweenRoundsMessages(queue: MessageQueue): QueuedMessage[] {
    const pending = queue.peekAll();
    const toInject: QueuedMessage[] = [];
    const keep: QueuedMessage[] = [];
    for (const msg of pending) {
      if (msg.deliveryMode === 'between-rounds') {
        toInject.push(msg);
        continue;
      }
      keep.push(msg);
    }
    if (toInject.length === 0) {
      return [];
    }
    // Replace queue contents: re-prepend kept messages in order after draining.
    queue.drainAll();
    for (const msg of keep) {
      queue.enqueue(msg);
    }
    return toInject;
  }

  //#endregion

  async run<I, O>(s: Step<ContextMemory, I, O>, input: I, ctx: Context): Promise<O> {
    return execute(s, input, ctx);
  }

  /** Run all layer `init` hooks before the first step executes. Per spec 11,
   *  init MUST complete before any recall fires so layer state is populated. */
  private async initAndRun<I, O>(s: Step<ContextMemory, I, O>, input: I, ctx: Context): Promise<O> {
    const layers = ctx.layers;
    const storage = this.config.storage;
    if (layers && layers.length > 0 && storage) {
      await this.initLayers(layers, ctx, storage);
    }
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
      const impl = frameworkCast<{
        unifiedTools: ReadonlyArray<Tool>;
      }>(ctx);
      impl.unifiedTools = allTools;
    }
  }

  private toExecCtx(ctx: Context): ExecutionContext {
    return contextToExecCtx(ctx, {
      callModel: (request) => this.callModel(request),
    });
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
      budgets: resolveLayerBudgets(layers),
      store: this.layerStateStore,
    });
  }

  async storeLayers(layers: MemoryLayer[], response: LLMResponse, ctx: Context): Promise<void> {
    const storage = this.config.storage;
    if (!storage) {
      return;
    }
    await storeLayers({
      layers,
      response,
      ctx: this.toExecCtx(ctx),
      log: ctx.itemLog,
      store: this.layerStateStore,
      storage,
    });
  }

  async disposeLayers(layers: MemoryLayer[], ctx: Context): Promise<void> {
    await disposeLayers({
      layers,
      ctx: this.toExecCtx(ctx),
      store: this.layerStateStore,
    });
  }

  async checkpoint(_ctx: Context): Promise<void> {}

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

//#region Text extraction helper

function itemToText(msg: QueuedMessage): string {
  if (typeof msg.input === 'string') {
    return msg.input;
  }
  const items = Array.isArray(msg.input)
    ? msg.input
    : [
        msg.input,
      ];
  const texts: string[] = [];
  for (const item of items) {
    if (item.type !== 'message') {
      continue;
    }
    for (const part of item.content) {
      if (part.type === 'input_text' || part.type === 'output_text') {
        texts.push(part.text);
      }
    }
  }
  return texts.join('\n');
}

//#endregion
