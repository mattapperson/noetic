import { frameworkCast, ItemSchemaRegistry, NoeticConfigError } from '@noetic-tools/types';
import { SpanImpl } from '../observability/span-impl';
import { NoopExporter } from '../observability/trace-exporter';
import {
  createInMemoryFsAdapter,
  createInMemoryShellAdapter,
  createInMemorySubprocessAdapter,
  OpenRouter,
} from './deps/adapters';
import type { DetachedSpawnOverrides } from './deps/interpreter';
import {
  collectAllTools,
  deduplicateTools,
  dispatchStepThroughAdapter,
  execute,
} from './deps/interpreter';
import type { LayerStateStore, RecallCache } from './deps/memory';
import {
  afterModelCallLayers,
  allocateBudgets,
  assembleView,
  beforeToolCallLayers,
  contextToExecCtx,
  createLayerStateStore,
  createRecallCache,
  DEFAULT_PROJECTION,
  disposeLayers,
  executeRerender,
  initLayers,
  projectHistoryLayers,
  recallLayers,
  recallLayersAtomic,
  recallLayersEventual,
  resolveLayerTools,
  runAppendPipeline,
  storeLayers,
} from './deps/memory';
import type { CheckpointStore, EventBroadcaster, QueuedMessage } from './deps/runtime';
import {
  buildItemStream,
  ChannelStore,
  ContextImpl,
  captureCheckpoint,
  createInMemoryStorage,
  filterReasoningStream,
  filterTextStream,
  restoreFromCheckpoint,
  SessionRunner,
  snapshotCwdState,
} from './deps/runtime';
import type {
  AgentConfig,
  AgentHarnessContract,
  AgentHooks,
  CallModelRequest,
  Channel,
  ChannelHandle,
  Context,
  ContextMemory,
  CwdState,
  DeliveryMode,
  DetachedHandle,
  ExecuteInput,
  ExecuteOptions,
  ExecutionContext,
  ExternalChannel,
  FsAdapter,
  HarnessResponse,
  HarnessStatus,
  Item,
  ItemSchemaExtensions,
  LLMResponse,
  LlmProviderConfig,
  MemoryLayer,
  ProjectionPolicy,
  RecallLayerOutput,
  SessionScope,
  ShellAdapter,
  Span,
  SteeringDecision,
  Step,
  StorageAdapter,
  StreamEvent,
  StreamingItem,
  SubprocessAdapter,
  Tool,
  TraceExporter,
  ZodType,
} from './deps/types';
import { SteeringAction } from './deps/types';
import type { SessionCtxExtension } from './model-call';
import { AgentHarnessModelCaller } from './model-call';

export { createStreamIdleWatchdog } from './model-call';

import { buildItemSchemaRegistry } from './model-schema';

//#region Types

interface AgentHarnessOpts<TParams extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  initialStep?: Step<ContextMemory, string, string>;
  /** Default memory layers applied to every context created via `createContext()` / `execute()`. */
  memory?: MemoryLayer[];
  storage?: StorageAdapter;
  hooks?: AgentHooks;
  /**
   * Harness-wide tool pool. Merged (identity-deduplicated) with tools
   * collected from `initialStep` to form every context's `unifiedTools`.
   * Use this when the workflow step tree is static and tools are supplied
   * per harness instance rather than baked into individual `step.llm` calls.
   */
  tools?: Tool[];
  params: TParams;
  paramsSchema?: ZodType<TParams>;
  /** Filesystem adapter. Defaults to local node:fs when not provided. */
  fs?: FsAdapter;
  /** Shell adapter. Defaults to local sh when not provided. */
  shell?: ShellAdapter;
  /** Subprocess adapter. Defaults to an in-memory, same-process adapter. */
  subprocess?: SubprocessAdapter;
  /**
   * Checkpoint store used by `harness.checkpoint(ctx)` / `harness.restore()`.
   * When absent, checkpoint/restore are no-ops — a zero-config harness keeps
   * its current ephemeral semantics. Construct with `createCheckpointStore`
   * to enable durable execution.
   */
  checkpointStore?: CheckpointStore;
  llm?: LlmProviderConfig;
  /** Harness-wide item schema extensions. */
  itemSchemas?: ItemSchemaExtensions;
  /** Whether unknown extension item types must match a registered schema. Defaults to true. */
  strictItemSchemas?: boolean;
  /** Default projection policy for all LLM steps. Individual steps override via `step.projection`. */
  projection?: ProjectionPolicy;
  /** When true, every layer is recalled atomically regardless of its `recallMode`. */
  forceAtomicRecall?: boolean;
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
  /**
   * Initial working directory for the harness. Used as the seed value for the
   * shared `cwdState.cwd` on every Context this harness creates, including
   * those produced by spawn/fork. Defaults to `process.cwd()`.
   */
  initialCwd?: string;
  /** @internal Test-only escape hatch to inject a mock callModel implementation. */
  _testCallModel?: (request: CallModelRequest) => Promise<LLMResponse>;
}

interface Session {
  readonly runner: SessionRunner;
  accumulatedItems: Item[];
}

//#endregion

const DEFAULT_THREAD_ID = '__default__';
/** Default idle-timeout for a single model call's streaming response. Chosen to be
 *  long enough that slow models aren't falsely aborted, but short enough that a
 *  stalled SSE becomes a visible error rather than a silent hang. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 120e3;

//#region Helpers

/**
 * Pick the right `cwdState` for a new Context.
 *
 * - `cwdInit` explicitly overrides everything (worktree isolation).
 * - Parent snapshot if present (snapshot, not shared reference — child `cd`
 *   does not leak to parent).
 * - Otherwise share the harness `rootCwdState` reference so successive root
 *   contexts see TUI/agent `cd`s carry across runs.
 */
function resolveContextCwdState(
  rootCwdState: CwdState,
  parent: Context | undefined,
  cwdInit: string | undefined,
): CwdState {
  if (cwdInit !== undefined) {
    return {
      cwd: cwdInit,
    };
  }
  if (parent) {
    return snapshotCwdState(parent);
  }
  return rootCwdState;
}

function createClient(config?: LlmProviderConfig): OpenRouter | undefined {
  const processValue = 'process' in globalThis ? globalThis.process : undefined;
  const envValue =
    typeof processValue === 'object' && processValue !== null && 'env' in processValue
      ? processValue.env
      : undefined;
  const openRouterApiKey =
    typeof envValue === 'object' && envValue !== null && 'OPENROUTER_API_KEY' in envValue
      ? envValue.OPENROUTER_API_KEY
      : undefined;
  const apiKey =
    config?.apiKey ?? (typeof openRouterApiKey === 'string' ? openRouterApiKey : undefined);
  if (!apiKey) {
    return undefined;
  }
  if (config?.cache) {
    // Inject `X-OpenRouter-Cache: true` on every request so OpenRouter serves
    // identical model calls from cache without re-billing (deterministic re-runs).
    return new OpenRouter({
      apiKey,
      hooks: {
        beforeRequest: (_ctx, request) => {
          request.headers.set('X-OpenRouter-Cache', 'true');
          return request;
        },
      },
    });
  }
  return new OpenRouter({
    apiKey,
  });
}

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
  readonly subprocess: SubprocessAdapter;
  /**
   * Optional durable-execution store. When present, `checkpoint(ctx)` writes
   * a `CheckpointSnapshot`; when absent, it's a no-op.
   * @internal
   */
  readonly checkpointStore?: CheckpointStore;
  private readonly initialStep?: Step<ContextMemory, string, string>;
  /** Harness-wide tool pool merged into every context's `unifiedTools`. */
  private readonly harnessTools: ReadonlyArray<Tool>;
  /** @internal Memory layers configured for this harness. Exposed non-private
   *  so free functions in `runtime/durable/` (checkpoint/restore) can read it
   *  without friend-class gymnastics. Do not access from outside core. */
  readonly _memory?: MemoryLayer[];
  private readonly client?: OpenRouter;
  private readonly channelStore: ChannelStore;
  private readonly callModelOverride?: (request: CallModelRequest) => Promise<LLMResponse>;
  private readonly defaultDeliveryMode: DeliveryMode;
  private readonly streamIdleTimeoutMs: number;
  private readonly sessions = new Map<string, Session>();
  readonly layerStateStore: LayerStateStore;
  /** Per-harness memoization cache for `recallMode: 'eventual'` layers. */
  readonly recallCache: RecallCache;
  readonly traceExporter: TraceExporter;
  /**
   * Long-lived shared cwd state. The same reference is seeded into every
   * root Context this harness creates, so successive `run()` calls — and the
   * TUI — observe each other's `cd`s.
   */
  readonly rootCwdState: CwdState;
  /** @internal Item schema registry. Exposed non-private so free functions
   *  in `runtime/durable/` (restore) can parse persisted items. Do not
   *  access from outside core. */
  readonly itemSchemas: ItemSchemaRegistry;

  constructor(opts: AgentHarnessOpts<TParams>) {
    const validatedParams = opts.paramsSchema ? opts.paramsSchema.parse(opts.params) : opts.params;

    this.config = {
      name: opts.name,
      storage: opts.storage ?? createInMemoryStorage(),
      hooks: opts.hooks,
      params: validatedParams,
      itemSchemas: opts.itemSchemas,
      strictItemSchemas: opts.strictItemSchemas ?? true,
      projection: opts.projection,
      forceAtomicRecall: opts.forceAtomicRecall,
    };
    this.fs = opts.fs ?? createInMemoryFsAdapter();
    this.shell = opts.shell ?? createInMemoryShellAdapter();
    this.subprocess = opts.subprocess ?? createInMemorySubprocessAdapter();
    this.checkpointStore = opts.checkpointStore;
    this.initialStep = opts.initialStep;
    this.harnessTools = opts.tools ?? [];
    this._memory = opts.memory;
    this.callModelOverride = opts._testCallModel;
    this.client = opts._testCallModel ? undefined : createClient(opts.llm);
    this.channelStore = new ChannelStore();
    this.traceExporter = opts.traceExporter ?? new NoopExporter();
    this.layerStateStore =
      opts.layerStateStore ??
      createLayerStateStore((layerId, hook, error) => {
        console.warn(`[noetic] memory layer '${layerId}' ${hook} error:`, error);
      });
    this.recallCache = createRecallCache();
    this.defaultDeliveryMode = opts.defaultDeliveryMode ?? 'next-turn';
    this.streamIdleTimeoutMs = opts.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    this.itemSchemas = new ItemSchemaRegistry(opts.itemSchemas, {
      strictUnknownExtensions: opts.strictItemSchemas ?? true,
    });
    this.rootCwdState = {
      cwd: opts.initialCwd ?? '/',
    };
  }

  /**
   * Update the harness-wide root cwd. The TUI calls this in response to a
   * user-issued `! cd`, so the next root Context (and any tool inspecting
   * `harness.rootCwdState.cwd`) observes the new value. Caller is responsible
   * for passing an absolute, validated path.
   */
  setRootCwd(nextCwd: string): void {
    if (nextCwd === this.rootCwdState.cwd) {
      return;
    }
    this.rootCwdState.previousCwd = this.rootCwdState.cwd;
    this.rootCwdState.cwd = nextCwd;
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
    return buildItemStream(session.runner.broadcaster, this.itemSchemas);
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

  seedSessionHistory(threadId: string, items: ReadonlyArray<Item>): void {
    const session = this.getOrCreateSession(threadId);
    session.accumulatedItems = [
      ...items,
    ];
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
          if (this.initialStep || this.harnessTools.length > 0) {
            const stepTools = this.initialStep ? collectAllTools(this.initialStep) : [];
            this.setUnifiedTools(ctx, [
              ...stepTools,
              ...this.harnessTools,
            ]);
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
    return new AgentHarnessModelCaller({
      agentName: this.config.name,
      itemSchemas: this.itemSchemas,
      client: this.client,
      callModelOverride: this.callModelOverride,
      streamIdleTimeoutMs: this.streamIdleTimeoutMs,
      harness: this,
    }).callModel(request);
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
    overrides?: DetachedSpawnOverrides,
  ): DetachedHandle<O> {
    return dispatchStepThroughAdapter(this, s, input, parentCtx, overrides);
  }

  createContext(opts?: {
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    memory?: MemoryLayer[];
    /**
     * Initial cwd for the new context. When set, takes precedence over both
     * the parent snapshot and the harness root cwd — used by worktree
     * isolation to root a child agent at the worktree path.
     */
    cwdInit?: string;
    _broadcaster?: EventBroadcaster;
  }): Context {
    const { memory: memoryLayers, cwdInit, ...rest } = opts ?? {};
    const effectiveMemory = memoryLayers ?? this._memory;
    const itemSchemas = buildItemSchemaRegistry({
      base: this.itemSchemas,
      layers: effectiveMemory,
    });
    return new ContextImpl({
      ...rest,
      harness: this,
      channelStore: this.channelStore,
      layers: effectiveMemory,
      itemSchemas,
      cwdState: resolveContextCwdState(this.rootCwdState, opts?.parent, cwdInit),
    });
  }

  send<T>(channel: Channel<T>, value: T, ctx: Context): Promise<void> {
    // Internal sender: back-pressured on full queue channels. The calling
    // context's abort signal rejects a parked send with 'cancelled'.
    const signal = ctx instanceof ContextImpl ? ctx.abortSignal : undefined;
    return this.channelStore.send(channel, value, {
      signal,
    });
  }

  recv<T>(
    channel: Channel<T>,
    ctx: Context,
    opts?: {
      timeout?: number;
    },
  ): Promise<T> {
    // Wire the calling context's abort signal so ctx.abort() rejects a
    // pending recv with { kind: 'cancelled' } instead of hanging.
    const signal = ctx instanceof ContextImpl ? ctx.abortSignal : undefined;
    return this.channelStore.recv(channel, opts?.timeout, signal);
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
      budgets: this.layerBudgets(layers),
      store: this.layerStateStore,
      itemSchemas: this.itemSchemas,
    });
  }

  /** Allocate per-layer recall budgets from the harness projection policy. */
  private layerBudgets(layers: MemoryLayer[]): Map<string, number> {
    const policy = this.config.projection ?? DEFAULT_PROJECTION;
    const { allocations } = allocateBudgets({
      layers,
      totalBudget: policy.tokenBudget,
      systemPromptTokens: 0,
      responseReserve: policy.responseReserve,
    });
    return new Map(
      allocations.map((a) => [
        a.layerId,
        a.allocated,
      ]),
    );
  }

  async recallLayersAtomic(
    layers: MemoryLayer[],
    input: string,
    ctx: Context,
    budgets: Map<string, number>,
  ): Promise<RecallLayerOutput[]> {
    return recallLayersAtomic({
      layers,
      query: input,
      ctx: this.toExecCtx(ctx),
      log: ctx.itemLog,
      budgets,
      store: this.layerStateStore,
      itemSchemas: this.itemSchemas,
      forceAtomic: this.config.forceAtomicRecall,
    });
  }

  async recallLayersEventual(
    layers: MemoryLayer[],
    input: string,
    ctx: Context,
    budgets: Map<string, number>,
  ): Promise<RecallLayerOutput[]> {
    return recallLayersEventual({
      layers,
      query: input,
      ctx: this.toExecCtx(ctx),
      log: ctx.itemLog,
      budgets,
      store: this.layerStateStore,
      itemSchemas: this.itemSchemas,
      forceAtomic: this.config.forceAtomicRecall,
      cache: this.recallCache,
    });
  }

  /**
   * Compute the items array that would be sent to the model on the next turn —
   * the same arrangement `executeLLM` builds: harness-level memory layers'
   * recall outputs concatenated with the session's accumulated history.
   *
   * Read-mostly: `recallLayers` writes layer-state snapshots to
   * `layerStateStore` exactly as a real turn would, so successive previews
   * remain consistent with what the next real turn produces.
   */
  async previewRequestItems(scope?: SessionScope): Promise<ReadonlyArray<Item>> {
    const threadId = scope?.threadId ?? DEFAULT_THREAD_ID;
    // Read-only: if the session doesn't exist, treat history as empty rather
    // than allocating a SessionRunner for a debug/preview call.
    const existingSession = this.sessions.get(threadId);
    const historyItems: Item[] = existingSession
      ? [
          ...existingSession.accumulatedItems,
        ]
      : [];
    const ctx = this.createContext({
      items: historyItems,
      threadId,
      memory: this._memory,
    });
    const layers = ctx.layers ?? [];
    if (layers.length === 0) {
      return historyItems;
    }
    const recallResults = await this.recallLayers(layers, '', ctx);
    const layerOutputItems = recallResults.flatMap((r) => r.items);
    if (layerOutputItems.length === 0) {
      return historyItems;
    }
    return assembleView({
      systemPromptItems: [],
      layerOutputItems,
      historyItems,
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
      recallCache: this.recallCache,
    });
  }

  async disposeLayers(layers: MemoryLayer[], ctx: Context): Promise<void> {
    await disposeLayers({
      layers,
      ctx: this.toExecCtx(ctx),
      store: this.layerStateStore,
    });
  }

  //#region Checkpoint boundaries

  /**
   * Snapshot the execution state at a checkpoint boundary.
   *
   * Fires at four well-defined points on the happy path:
   *   1. End of every `execute()` that mutated the item log — so a crash
   *      between turns lands on a snapshot that includes the user/assistant
   *      items that actually flowed.
   *   2. After `detachedSpawn()` settles (success or failure) — the parent's
   *      record of running/completed children stays consistent with the
   *      adapter's handle manifest.
   *   3. After an ask-user enqueue — a restart can replay the pending modal
   *      to the TUI.
   *   4. After `runAppendPipeline` — layer state can mutate as items land,
   *      so the snapshot must follow the mutation.
   *
   * Delegates to `captureCheckpoint` / `restoreFromCheckpoint` in
   * `runtime/durable/harness-checkpoints` so the ~140 lines of snapshot
   * logic live beside the other durability machinery.
   */
  async checkpoint(ctx: Context): Promise<void> {
    return captureCheckpoint(this, ctx);
  }

  /**
   * Rebuild a `Context` from a previously-persisted snapshot. Returns `null`
   * if no snapshot is recorded for `executionId`. Surface a typed
   * `NoeticConfigError(CHECKPOINT_SCHEMA_MISMATCH)` when the snapshot's
   * schema version is unrecognised — the caller is expected to discard the
   * checkpoint via `CheckpointStore.clear()` and start a fresh execution.
   */
  async restore(executionId: string): Promise<Context | null> {
    return restoreFromCheckpoint(this, executionId);
  }

  //#endregion

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

  async projectHistory(
    layers: MemoryLayer[],
    items: ReadonlyArray<Item>,
    ctx: Context,
  ): Promise<ReadonlyArray<Item>> {
    const hasHook = layers.some((l) => l.hooks.projectHistory);
    if (!hasHook) {
      return items;
    }
    return projectHistoryLayers({
      layers,
      items,
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
      itemSchemas: this.itemSchemas,
    });
  }
}

//#endregion
