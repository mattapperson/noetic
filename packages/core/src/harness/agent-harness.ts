import { frameworkCast, ItemSchemaRegistry, NoeticConfigError } from '@noetic-tools/types';
import { SpanImpl } from '../observability/span-impl';
import { NoopExporter } from '../observability/trace-exporter';
import {
  createInMemoryFsAdapter,
  createInMemoryShellAdapter,
  createInMemorySubprocessAdapter,
  OpenRouter,
} from './deps/adapters';
import type { LayerStateStore, RecallCache } from './deps/context';
import {
  afterModelCallLayers,
  allocateBudgets,
  assembleView,
  beforeToolCallLayers,
  completeLayers,
  contextToExecCtx,
  createContextCacheStore,
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
} from './deps/context';
import type { DetachedSpawnOverrides } from './deps/interpreter';
import {
  collectAllTools,
  deduplicateTools,
  dispatchStepThroughAdapter,
  execute,
  prepareBandedView,
} from './deps/interpreter';
import type {
  CheckpointStore,
  EventBroadcaster,
  QueuedMessage,
  RestoreCheckpointOptions,
  StepLedgerRetention,
  StepLedgerStore,
} from './deps/runtime';
import {
  buildItemStream,
  ChannelStore,
  ContextImpl,
  captureCheckpoint,
  clearCheckpoint,
  collectContextTree,
  createInMemoryStorage,
  createStepLedgerStore,
  filterReasoningStream,
  filterTextStream,
  resolveStepLedgerRetention,
  restoreFromCheckpoint,
  SessionRunner,
  StepLedger,
  snapshotCwdState,
} from './deps/runtime';
import type {
  AcpLiveSession,
  AgentConfig,
  AgentHarnessContract,
  AgentHooks,
  CallModelRequest,
  Channel,
  ChannelHandle,
  Context,
  ContextCacheConfig,
  ContextCacheStore,
  ContextData,
  ContextLayer,
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
  ItemSchemaConfig,
  LLMResponse,
  LlmProviderConfig,
  ProjectionPolicy,
  RecallLayerOutput,
  SessionScope,
  SessionUsage,
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

/**
 * Storage-scoped environment configuration for `AgentHarness`.
 *
 * @public
 */
export interface StorageEnvironmentConfig {
  /**
   * Key-value storage adapter backing context-layer persistence and the
   * step-completion ledger. Defaults to an in-memory adapter.
   */
  adapter?: StorageAdapter;
  /**
   * Checkpoint store used by `harness.checkpoint(ctx)` / `harness.restore()`.
   * When absent, checkpoint/restore are no-ops — a zero-config harness keeps
   * its current ephemeral semantics. Construct with `createCheckpointStore`
   * to enable durable execution.
   */
  checkpointStore?: CheckpointStore;
  /** Layer-state store override. Defaults to an in-memory store. */
  layerStateStore?: LayerStateStore;
  /**
   * Bounds on the step-completion ledger that backs step-level resume. Only meaningful
   * alongside a `checkpointStore`. Defaults to `DEFAULT_STEP_LEDGER_RETENTION` — 128 KiB
   * per entry, 1000 entries per execution — so an unbounded run cannot grow an unbounded
   * ledger. Exceeding either cap costs resumability for the affected steps (they re-run),
   * never correctness.
   */
  stepLedgerRetention?: StepLedgerRetention;
}

/**
 * Execution-environment configuration for `AgentHarness`: the storage,
 * filesystem, shell, and subprocess surfaces the agent runs against.
 *
 * @public
 */
export interface AgentEnvironmentConfig {
  /** Storage configuration: adapter, durability stores, ledger retention. */
  storage?: StorageEnvironmentConfig;
  /** Filesystem adapter. Defaults to an in-memory adapter. */
  fs?: FsAdapter;
  /** Shell adapter. Defaults to an in-memory adapter. */
  shell?: ShellAdapter;
  /** Subprocess adapter. Defaults to an in-memory, same-process adapter. */
  subprocess?: SubprocessAdapter;
}

interface AgentHarnessOpts<TParams extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  /** Root step tree executed for every turn submitted via `execute()`. */
  agentGraph?: Step<ContextData, string, string>;
  /** Default context layers applied to every context created via `createContext()` / `execute()`. */
  contextLayers?: ContextLayer[];
  hooks?: AgentHooks;
  /**
   * Harness-wide tool pool. Merged (identity-deduplicated) with tools
   * collected from `agentGraph` to form every context's `unifiedTools`.
   * Use this when the workflow step tree is static and tools are supplied
   * per harness instance rather than baked into individual `step.callModel` calls.
   */
  tools?: Tool[];
  params: TParams;
  paramsSchema?: ZodType<TParams>;
  /** Execution environment: storage, filesystem, shell, subprocess. */
  environment?: AgentEnvironmentConfig;
  /** Default provider configuration for model calls made through this harness. */
  callModelDefaults?: LlmProviderConfig;
  /** Harness-wide item schema extensions and validation strictness. */
  itemSchemas?: ItemSchemaConfig;
  /** Default projection policy for all LLM steps. Individual steps override via `step.projection`. */
  projection?: ProjectionPolicy;
  /** When true, every layer is recalled atomically regardless of its `recallMode`. */
  forceAtomicRecall?: boolean;
  /** Tuning for prompt-cache anchoring. See `ContextCacheConfig` for the defaults. */
  contextCache?: ContextCacheConfig;
  traceExporter?: TraceExporter;
  /** Default delivery mode for messages that don't specify one. Defaults to `next-turn`. */
  defaultDeliveryMode?: DeliveryMode;
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

/** The Noetic platform's OpenAI-Responses-compatible inference base URL. */
const NOETIC_DEFAULT_BASE_URL = 'https://platform.noetic.tools/v1';

/** Env vars consulted when resolving the LLM client (read defensively so the
 *  harness also works in runtimes without a `process` global, e.g. the browser). */
interface LlmEnv {
  noeticApiKey?: string;
  noeticBaseUrl?: string;
  openrouterApiKey?: string;
}

function readLlmEnv(): LlmEnv {
  const processValue = 'process' in globalThis ? globalThis.process : undefined;
  const env =
    typeof processValue === 'object' && processValue !== null && 'env' in processValue
      ? processValue.env
      : undefined;
  if (typeof env !== 'object' || env === null) {
    return {};
  }
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;
  return {
    noeticApiKey: 'NOETIC_API_KEY' in env ? str(env.NOETIC_API_KEY) : undefined,
    noeticBaseUrl: 'NOETIC_BASE_URL' in env ? str(env.NOETIC_BASE_URL) : undefined,
    openrouterApiKey: 'OPENROUTER_API_KEY' in env ? str(env.OPENROUTER_API_KEY) : undefined,
  };
}

/** @public Effective client options resolved from config + environment. */
export interface ResolvedLlmClient {
  apiKey: string;
  /** Undefined means "use the SDK's default OpenRouter base URL". */
  serverURL?: string;
  cache: boolean;
}

/**
 * Resolve the effective LLM client options from the provider config + environment.
 * Defaults to the Noetic platform (`provider: 'noetic'`): the `'noetic'` provider
 * authenticates with `NOETIC_API_KEY` and targets the Noetic platform base URL,
 * while `'openrouter'` authenticates with `OPENROUTER_API_KEY` and uses the SDK's
 * default OpenRouter endpoint. Returns undefined when no API key is available.
 * Exported for testing.
 */
export function resolveLlmClient(
  config: LlmProviderConfig | undefined,
  env: LlmEnv,
): ResolvedLlmClient | undefined {
  const provider = config?.provider ?? 'noetic';
  const apiKey =
    config?.apiKey ?? (provider === 'noetic' ? env.noeticApiKey : env.openrouterApiKey);
  if (!apiKey) {
    return undefined;
  }
  const serverURL =
    provider === 'noetic'
      ? (config?.baseUrl ?? env.noeticBaseUrl ?? NOETIC_DEFAULT_BASE_URL)
      : config?.baseUrl;
  return {
    apiKey,
    serverURL,
    cache: config?.cache ?? false,
  };
}

/**
 * Ask the provider to cache the prompt prefix.
 *
 * Anthropic caching is opt-in — without a breakpoint it caches nothing however
 * stable the prefix is, measured against live models. OpenRouter accepts a
 * `cache_control` directive on the request and places the breakpoints itself;
 * providers that cache on their own (OpenAI, Gemini) ignore it.
 *
 * It has to be injected here rather than passed with the other request fields:
 * the SDK validates the request against a generated schema that drops keys it
 * does not know, and `cache_control` is one of them.
 */
async function addCacheBreakpoint(request: Request): Promise<Request> {
  const body = await request.clone().text();
  if (!body) {
    return request;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return request;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return request;
  }
  return new Request(request, {
    body: JSON.stringify({
      ...payload,
      cache_control: {
        type: 'ephemeral',
      },
    }),
  });
}

function createClient(
  config?: LlmProviderConfig,
  contextCache?: ContextCacheConfig,
): OpenRouter | undefined {
  const resolved = resolveLlmClient(config, readLlmEnv());
  if (!resolved) {
    return undefined;
  }
  const options: {
    apiKey: string;
    serverURL?: string;
  } = {
    apiKey: resolved.apiKey,
  };
  if (resolved.serverURL) {
    options.serverURL = resolved.serverURL;
  }

  // A cache write costs more than a plain read, so the breakpoint only pays off
  // when something is holding the prefix still — which is what anchoring does.
  const wantsBreakpoint = contextCache?.enabled !== false;
  if (!resolved.cache && !wantsBreakpoint) {
    return new OpenRouter(options);
  }
  return new OpenRouter({
    ...options,
    hooks: {
      beforeRequest: async (_ctx, request) => {
        if (resolved.cache) {
          // Serve identical model calls from OpenRouter's own response cache
          // without re-billing (deterministic re-runs).
          request.headers.set('X-OpenRouter-Cache', 'true');
        }
        return wantsBreakpoint ? addCacheBreakpoint(request) : request;
      },
    },
  });
}

//#region AgentHarness

/**
 * Default agent harness for executing agent steps with built-in channel, context, and trace support.
 * Provides channel store, context layer lifecycle, and trace export with no external dependencies.
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
  /**
   * Append-only step ledger backing resume. Present exactly when durability is on
   * (a `CheckpointStore` is configured), so a zero-config harness records nothing.
   * @internal
   */
  readonly stepLedgerStore?: StepLedgerStore;
  /**
   * Resolved retention bounds for that ledger. Validated at construction so a bad cap
   * is a loud config error rather than a run that silently records nothing.
   * @internal
   */
  readonly stepLedgerRetention: Required<StepLedgerRetention>;
  private readonly agentGraph?: Step<ContextData, string, string>;
  /** Harness-wide tool pool merged into every context's `unifiedTools`. */
  private readonly harnessTools: ReadonlyArray<Tool>;
  /** @internal Context layers configured for this harness. Exposed non-private
   *  so free functions in `runtime/durable/` (checkpoint/restore) can read it
   *  without friend-class gymnastics. Do not access from outside core. */
  readonly _contextLayers?: ContextLayer[];
  private readonly client?: OpenRouter;
  private readonly channelStore: ChannelStore;
  /** Re-entrant `run()` depth per root context id — see `executeClosingChannels`. */
  private readonly rootRunDepth = new Map<string, number>();
  private readonly callModelOverride?: (request: CallModelRequest) => Promise<LLMResponse>;
  private readonly defaultDeliveryMode: DeliveryMode;
  private readonly sessions = new Map<string, Session>();
  /**
   * @internal Cross-step harness sessions keyed by `step.session.reuse`, kept
   * alive for the life of this harness so reused coding-agent sessions span
   * multiple steps. Reached by the interpreter's harness handler via
   * `frameworkCast`; do not access from outside core.
   */
  readonly acpSessions = new Map<string, AcpLiveSession>();

  /**
   * Close every ACP connection this harness still holds, whatever its
   * keep-alive scope. A connection owns a live agent — usually a child process
   * whose stdio keeps the event loop alive — so a `keepAlive: 'harness'`
   * session must be closed by its owner or the host will not exit. Idempotent.
   * @public
   */
  async closeAcpSessions(): Promise<void> {
    await this.closeAcpSessionsWhere(() => true);
  }

  /**
   * Collect the connections a finished root run owns. `keepAlive: 'harness'`
   * opted out of that collection, so it survives until {@link closeAcpSessions}.
   */
  private async closeAcpSessionsAfterRun(): Promise<void> {
    await this.closeAcpSessionsWhere((entry) => entry.keepAlive !== 'harness');
  }

  private async closeAcpSessionsWhere(
    predicate: (entry: AcpLiveSession) => boolean,
  ): Promise<void> {
    const doomed: AcpLiveSession[] = [];
    for (const [key, entry] of this.acpSessions) {
      if (predicate(entry)) {
        doomed.push(entry);
        this.acpSessions.delete(key);
      }
    }
    await Promise.all(doomed.map((entry) => entry.connection.close().catch(() => undefined)));
  }
  readonly layerStateStore: LayerStateStore;
  /** Per-harness memoization cache for `recallMode: 'eventual'` layers. */
  readonly recallCache: RecallCache;
  /** Per-harness pinned anchor output and epoch bookkeeping, keyed by cache lineage. */
  readonly contextCache: ContextCacheStore;
  /**
   * Execution ids whose layer `init` hooks have already run, so repeated/nested
   * `run()` calls and the session turn path never re-init (which would clobber
   * accumulated in-memory state by re-hydrating from storage). Keyed by
   * `ctx.id` (the layer-state store's executionId).
   */
  private readonly initializedExecutions = new Set<string>();
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
    const environment = opts.environment;
    const storageEnv = environment?.storage;

    this.config = {
      name: opts.name,
      storage: storageEnv?.adapter ?? createInMemoryStorage(),
      hooks: opts.hooks,
      params: validatedParams,
      itemSchemas: opts.itemSchemas,
      projection: opts.projection,
      forceAtomicRecall: opts.forceAtomicRecall,
      contextCache: opts.contextCache,
    };
    this.fs = environment?.fs ?? createInMemoryFsAdapter();
    this.shell = environment?.shell ?? createInMemoryShellAdapter();
    this.subprocess = environment?.subprocess ?? createInMemorySubprocessAdapter();
    this.checkpointStore = storageEnv?.checkpointStore;
    this.stepLedgerStore = storageEnv?.checkpointStore
      ? createStepLedgerStore({
          storage: this.config.storage ?? createInMemoryStorage(),
        })
      : undefined;
    this.stepLedgerRetention = resolveStepLedgerRetention(storageEnv?.stepLedgerRetention);
    this.agentGraph = opts.agentGraph;
    this.harnessTools = opts.tools ?? [];
    this._contextLayers = opts.contextLayers;
    this.callModelOverride = opts._testCallModel;
    this.client = opts._testCallModel
      ? undefined
      : createClient(opts.callModelDefaults, opts.contextCache);
    this.channelStore = new ChannelStore();
    this.traceExporter = opts.traceExporter ?? new NoopExporter();
    this.layerStateStore =
      storageEnv?.layerStateStore ??
      createLayerStateStore((layerId, hook, error) => {
        console.warn(`[noetic] context layer '${layerId}' ${hook} error:`, error);
      });
    this.recallCache = createRecallCache();
    this.contextCache = createContextCacheStore();
    this.defaultDeliveryMode = opts.defaultDeliveryMode ?? 'next-turn';
    this.itemSchemas = new ItemSchemaRegistry(opts.itemSchemas?.schemas, {
      strictUnknownExtensions: opts.itemSchemas?.strict ?? true,
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
    if (!this.agentGraph) {
      return Promise.reject(
        new NoeticConfigError({
          code: 'NO_STEP_CONFIGURED',
          message: 'No agentGraph configured on this harness.',
          hint: 'Pass `agentGraph` in constructor options, or use run() directly.',
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

  getUsage(scope?: SessionScope): SessionUsage {
    const threadId = scope?.threadId ?? DEFAULT_THREAD_ID;
    const session = this.sessions.get(threadId);
    if (!session) {
      return {
        inputTokens: 0,
        outputTokens: 0,
      };
    }
    return session.runner.getUsage();
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
        // `state` / `context` for the turn. If multiple messages are drained
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
            contextLayers: perTurnOptions.contextLayers,
            _broadcaster: session.runner.broadcaster,
          });
          const ext = frameworkCast<Context & SessionCtxExtension>(ctx);
          ext._sessionQueue = session.runner.queue;
          ext._sessionBetweenRounds = true;
          ext._sessionRunnerAgentName = this.config.name;
          if (this.agentGraph || this.harnessTools.length > 0) {
            const stepTools = this.agentGraph ? collectAllTools(this.agentGraph) : [];
            this.setUnifiedTools(ctx, [
              ...stepTools,
              ...this.harnessTools,
            ]);
          }
          return ctx;
        },
        runTurn: async (ctx, _turn, signal) => {
          if (!this.agentGraph) {
            throw new NoeticConfigError({
              code: 'NO_STEP_CONFIGURED',
              message: 'No agentGraph configured on this harness.',
              hint: 'Pass `agentGraph` in constructor options.',
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
          const result = await this.initAndRun(this.agentGraph, '', ctx);
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
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      harness: this,
      traceExporter: this.traceExporter,
    }).callModel(request);
  }

  //#endregion

  async run<I, O>(s: Step<ContextData, I, O>, input: I, ctx: Context): Promise<O> {
    // Populate the unified tool pool when an embedder drives a step directly on
    // a bare `createContext()` context (the turn pipeline does this per turn).
    // Without it, steps that resolve tools dynamically from `ctx.unifiedTools`
    // — and any sub-agents spawned from them — would see no tools.
    if (!ctx.unifiedTools && (s !== undefined || this.harnessTools.length > 0)) {
      this.setUnifiedTools(ctx, [
        ...collectAllTools(s),
        ...this.harnessTools,
      ]);
    }
    // Hydrate/recall/persist context on the bare `run()` path too (issue #48):
    // configuring `context` + `storage` must "just work" without going through
    // `execute()`/`seedSessionHistory`. Idempotent — see `ensureLayersInit`.
    await this.ensureLayersInit(ctx);
    return this.executeClosingChannels(s, input, ctx);
  }

  /** Run all layer `init` hooks before the first step executes. Per spec 11,
   *  init MUST complete before any recall fires so layer state is populated. */
  private async initAndRun<I, O>(s: Step<ContextData, I, O>, input: I, ctx: Context): Promise<O> {
    await this.ensureLayersInit(ctx);
    return this.executeClosingChannels(s, input, ctx);
  }

  /**
   * Run `execute`, closing the execution's external channels when the
   * OUTERMOST run on a root context finishes (spec 06 Lifecycle: handles flip
   * `closed`, channel streams end). Patterns re-enter `run()` with the same
   * root context (`ctx.harness.run(step, input, ctx)`), so a depth count —
   * not the return itself — marks root completion. Child-context runs never
   * close anything.
   */
  private async executeClosingChannels<I, O>(
    s: Step<ContextData, I, O>,
    input: I,
    ctx: Context,
  ): Promise<O> {
    if (ctx.parent !== null) {
      return execute(s, input, ctx);
    }
    const depth = this.rootRunDepth.get(ctx.id) ?? 0;
    if (depth === 0) {
      // A restored or sequentially re-run root context reuses its id — clear
      // any closure from a previous completion so its channels work again.
      this.channelStore.openExecution(ctx.id);
    }
    this.rootRunDepth.set(ctx.id, depth + 1);
    try {
      return await execute(s, input, ctx);
    } finally {
      const remaining = (this.rootRunDepth.get(ctx.id) ?? 1) - 1;
      if (remaining > 0) {
        this.rootRunDepth.set(ctx.id, remaining);
      } else {
        this.rootRunDepth.delete(ctx.id);
        this.channelStore.closeExecution(ctx.id);
        await this.closeAcpSessionsAfterRun();
      }
    }
  }

  /**
   * Idempotently run layer `init` hooks for `ctx` (keyed by `ctx.id`). Init
   * MUST complete before any recall/store fires so init-bearing layers are not
   * treated as disabled. Guarded so nested/repeated `run()` calls and the
   * session turn path never re-init — re-init would re-hydrate from storage and
   * clobber accumulated in-memory state.
   */
  private async ensureLayersInit(ctx: Context): Promise<void> {
    const layers = ctx.layers;
    const storage = this.config.storage;
    if (!layers || layers.length === 0 || !storage) {
      return;
    }
    if (this.initializedExecutions.has(ctx.id)) {
      return;
    }
    this.initializedExecutions.add(ctx.id);
    await this.initLayers(layers, ctx, storage);
  }

  detachedSpawn<I, O>(
    s: Step<ContextData, I, O>,
    input: I,
    parentCtx: Context,
    overrides?: DetachedSpawnOverrides,
  ): DetachedHandle<O> {
    /* NOT a checkpoint boundary, despite spec 23 listing one here: a DetachedHandle's
     * settle is only observable via `await()`, and calling it internally would consume
     * the result the caller is holding. The handle manifest is the adapter's own
     * durability surface (`listLive`/`reattach`), so nothing is lost. */
    return dispatchStepThroughAdapter(this, s, input, parentCtx, overrides);
  }

  createContext(opts?: {
    parent?: Context;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    contextLayers?: ContextLayer[];
    /**
     * Initial cwd for the new context. When set, takes precedence over both
     * the parent snapshot and the harness root cwd — used by worktree
     * isolation to root a child agent at the worktree path.
     */
    cwdInit?: string;
    _broadcaster?: EventBroadcaster;
  }): Context {
    const resolved = opts ?? {};
    // `ContextImpl` takes the layers as `layers`, so the option spelling is
    // dropped from `rest` rather than spread through under the wrong name.
    const { contextLayers, cwdInit, ...rest } = resolved;
    const effectiveLayers = contextLayers ?? this._contextLayers;
    const itemSchemas = buildItemSchemaRegistry({
      base: this.itemSchemas,
      layers: effectiveLayers,
    });
    /* The execution id is chosen here rather than inside ContextImpl so the ledger
     * can be keyed to it — the ledger's storage keys and `ctx.id` must agree for a
     * later `restore()` to find what this run recorded. */
    const executionId = crypto.randomUUID();
    return new ContextImpl({
      ...rest,
      id: executionId,
      harness: this,
      channelStore: this.channelStore,
      layers: effectiveLayers,
      itemSchemas,
      cwdState: resolveContextCwdState(this.rootCwdState, opts?.parent, cwdInit),
      // Without this `ctx.checkpoint()` is inert, and the boundaries below never
      // persist anything (a no-op when no CheckpointStore is configured).
      checkpointFn: (c) => this.checkpoint(c),
      ledger: this.stepLedgerStore
        ? new StepLedger({
            executionId,
            store: this.stepLedgerStore,
            retention: this.stepLedgerRetention,
          })
        : undefined,
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

  getChannelStream<T>(channel: ExternalChannel<T>, executionId: string): AsyncIterable<T> {
    return this.channelStore.subscribe(channel, executionId);
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

  async initLayers(layers: ContextLayer[], ctx: Context, storage: StorageAdapter): Promise<void> {
    await initLayers({
      layers,
      ctx: this.toExecCtx(ctx),
      storage,
      store: this.layerStateStore,
    });
  }

  async recallLayers(
    layers: ContextLayer[],
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
  private layerBudgets(layers: ContextLayer[]): Map<string, number> {
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
    layers: ContextLayer[],
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
    layers: ContextLayer[],
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
   * the same arrangement `executeLLM` builds: harness-level context layers'
   * recall outputs concatenated with the session's accumulated history.
   *
   * Runs layer `init` on the throwaway preview context first — exactly what
   * the next real turn's `ensureLayersInit` would do, re-hydrating thread/
   * resource-scoped state from storage. Without it, every init-bearing layer
   * is treated as disabled by the recall lifecycle and the preview silently
   * degenerates to bare history. The preview execution's store entries are
   * dropped afterwards so repeated previews don't grow the layer-state store.
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
      contextLayers: this._contextLayers,
    });
    const layers = ctx.layers ?? [];
    if (layers.length === 0) {
      return historyItems;
    }
    try {
      await this.ensureLayersInit(ctx);
      const recallResults = await this.recallLayers(layers, '', ctx);
      // Band the output the way a real turn would, but read-only: a preview
      // must not pin, count churn, or age the epoch, or looking at a
      // conversation would change what the next turn sends.
      const banded = await prepareBandedView({
        recallResults,
        layers,
        execCtx: contextToExecCtx(ctx),
        store: this.contextCache,
        config: this.config.contextCache,
        instructions: undefined,
        policy: this.config.projection ?? DEFAULT_PROJECTION,
        systemPromptItems: [],
        budgets: new Map(),
        readOnly: true,
      });
      if (
        banded.anchorItems.length === 0 &&
        banded.liveItems.length === 0 &&
        banded.deltaItems.length === 0
      ) {
        return historyItems;
      }
      return assembleView({
        systemPromptItems: [],
        layerOutputItems: banded.anchorItems,
        historyItems,
        liveLayerItems: banded.liveItems,
        deltaItems: banded.deltaItems,
      });
    } finally {
      await this.layerStateStore.flush?.(ctx.id);
      this.layerStateStore.cleanup(ctx.id);
      this.initializedExecutions.delete(ctx.id);
    }
  }

  async storeLayers(layers: ContextLayer[], response: LLMResponse, ctx: Context): Promise<void> {
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

  async disposeLayers(layers: ContextLayer[], ctx: Context): Promise<void> {
    // Drop the init guard so a deliberate dispose→run cycle re-hydrates from
    // storage (disposeLayers also clears the layer-state store for this id).
    this.initializedExecutions.delete(ctx.id);
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
   *
   * `opts` is the `createContext`-shaped wiring the host attached to the
   * original context (broadcaster, parent, state, context overrides). A
   * snapshot recovers data, not live objects — pass the same wiring here or
   * the resumed run gets an undecorated context and whatever depended on that
   * wiring (event streaming, mid-turn injection) stops working without
   * failing. Fields the snapshot owns — items, threadId, resourceId, cwd —
   * are not accepted; they always come from the persisted record.
   *
   * Decoration applied *after* construction (`Object.assign`ed fields, abort
   * registration) stays the host's job: apply it to the context this returns,
   * whose `id` is already the original `executionId`.
   */
  async restore(executionId: string, opts?: RestoreCheckpointOptions): Promise<Context | null> {
    return restoreFromCheckpoint(this, executionId, opts);
  }

  /**
   * Discard everything `restore(executionId)` would have used — the snapshot *and* the
   * step-completion ledger — so the next run of that execution starts clean.
   *
   * Hosts must call this rather than resume when the workflow itself changed. A resumed
   * run replays at the coarsest completed granularity: a parent step that finished
   * replays wholesale, so an edit to one of its children is never noticed and the stale
   * output wins. Divergence detection only catches a changed step *at* a recorded path.
   *
   * Also the right call after a terminal outcome (the execution finished, or the user
   * abandoned it) — `CheckpointStore.clear` alone leaves the ledger's per-step keys
   * behind, and nothing else enumerates them.
   */
  async clearCheckpoint(executionId: string): Promise<void> {
    return clearCheckpoint(this, executionId);
  }

  //#endregion

  /**
   * Cancel an execution: abort `ctx` and every live descendant context, then
   * run the context-layer teardown for each (spec 09, Cancellation).
   *
   * The abort itself fans out top-down and synchronously — `ctx.abort()`
   * cascades into every live fork path and spawn child, so no corner of the
   * tree keeps working while cleanup is in progress. Cleanup then runs
   * bottom-up: a child's `onComplete` / `dispose` fires before its parent's.
   *
   * Aborting a context rejects everything blocked on it (channel `recv`
   * waiters, parked senders) with `{ kind: 'cancelled' }`, stops its in-flight
   * model call and ACP agent turn, and makes the next step boundary throw
   * `cancelled`.
   *
   * Cancellation is cooperative: a layer hook already in flight is allowed to
   * settle, and step code that ignores `ctx.aborted` between `await`s runs to
   * its next boundary. Calling `cancel()` on an already-cancelled context is a
   * no-op.
   */
  async cancel(ctx: Context, reason?: string): Promise<void> {
    if (ctx.aborted) {
      return;
    }
    // Snapshot the tree first: `abort()` cascades and clears each context's
    // child registry, so collecting afterwards would find nothing.
    const tree = collectContextTree(ctx);
    ctx.abort(reason);
    for (const node of tree.reverse()) {
      await this.teardownCancelledContext(node);
    }
    // Cancellation completes the root execution (spec 06 Lifecycle): close
    // its external channels so handles flip `closed` and streams end.
    if (ctx.parent === null) {
      this.channelStore.closeExecution(ctx.id);
    }
  }

  /**
   * Run the layer lifecycle's abort path for one cancelled context:
   * `onComplete` with `outcome: 'aborted'`, then `dispose`. Both always run
   * under cancellation (spec 09, Cancellation item 5).
   */
  private async teardownCancelledContext(ctx: Context): Promise<void> {
    const layers = ctx.layers ?? [];
    if (layers.length === 0) {
      return;
    }
    await completeLayers({
      layers: [
        ...layers,
      ],
      ctx: this.toExecCtx(ctx),
      log: ctx.itemLog,
      outcome: 'aborted',
      store: this.layerStateStore,
    });
    await this.disposeLayers(
      [
        ...layers,
      ],
      ctx,
    );
  }

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
    layers: ContextLayer[],
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
    layers: ContextLayer[],
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
    layers: ContextLayer[],
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
    layers: ContextLayer[],
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
    const piped = await runAppendPipeline({
      layers,
      items,
      ctx: this.toExecCtx(ctx),
      log: ctx.itemLog,
      store: this.layerStateStore,
    });
    // Layer state can mutate as items land, so the snapshot must follow the fold.
    await this.checkpoint(ctx);
    return piped;
  }

  async executeRerender(
    requests: {
      layerId: string;
      slot: number;
      timing: 'immediate' | 'batched';
      scope: 'self' | 'slot-after' | 'all';
    }[],
    layers: ContextLayer[],
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
