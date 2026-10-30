import type {
  ArtifactStore,
  ConnectionStatus,
  ConnectionsConfig,
  ConnectionTrigger,
  SecretResolver,
} from '@noetic-tools/types';
import {
  CONNECTION_EVENT_ITEM_TYPE,
  frameworkCast,
  ItemSchemaRegistry,
  NoeticConfigError,
} from '@noetic-tools/types';
import type { Verifier } from '@noetic-tools/types/verify';
import { toStep } from '../builders/sequence';
import type { HarnessConnections } from '../connections/harness-wiring';
import { createHarnessConnections } from '../connections/harness-wiring';
import type { ConnectionRuntime } from '../connections/registry';
import { NoeticEvent } from '../observability/genai-attributes';
import { SpanImpl } from '../observability/span-impl';
import { NoopExporter } from '../observability/trace-exporter';
import { AcpSessionStore } from '../runtime/acp-session-store';
import { createInMemoryArtifactStore } from '../runtime/in-memory-artifact-store';
import { setHarnessInternals } from '../util/harness-internals';
import { callDecide } from './decide-call';
import {
  createInMemoryFsAdapter,
  createInMemoryShellAdapter,
  createInMemorySubprocessAdapter,
  HTTPClient,
  OpenRouter,
  OpenRouterSdk,
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
  notifyDecision,
  onSteerLayers,
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
  clearPendingEntries,
  collectAllTools,
  collectCustomItems,
  deduplicateTools,
  dispatchStepThroughAdapter,
  execute,
  graphConnectionNeeds,
  prepareBandedView,
  reconcileResumedConnections,
  someStep,
} from './deps/interpreter';
import type {
  ChannelWarning,
  CheckpointStore,
  EventBroadcaster,
  QueuedMessage,
  RestoreCheckpointOptions,
  SessionCtxExtension,
  SessionStore,
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
  createCheckpointStore,
  createInMemoryStorage,
  createSessionStore,
  createSpendLog,
  createStepLedgerStore,
  customItemGates,
  Drains,
  filterReasoningStream,
  filterTextStream,
  INTERRUPT_REASON,
  isSteer,
  resolveStepLedgerRetention,
  restoreFromCheckpoint,
  rootIdOf,
  SessionRunner,
  StepLedger,
  snapshotCwdState,
  warnToConsole,
} from './deps/runtime';
import type {
  AcpLiveSession,
  AcpSessionInfo,
  AgentConfig,
  AgentHarnessContract,
  AgentHooks,
  CallModelRequest,
  CancelOptions,
  Channel,
  ChannelHandle,
  Context,
  ContextCacheConfig,
  ContextCacheStore,
  ContextData,
  ContextLayer,
  CustomItem,
  CustomItemOf,
  CustomItemStreamEvent,
  CustomItemsBrand,
  CustomStreamingItem,
  CwdState,
  DecideRequest,
  DecideResponse,
  DecisionRecord,
  DeclaredItems,
  DeliveryMode,
  DetachedHandle,
  DrainReport,
  ExecuteInput,
  ExecuteOptions,
  ExecutionContext,
  ExecutionScope,
  ExecutionStatus,
  ExternalChannel,
  FsAdapter,
  HarnessResponse,
  HarnessStatus,
  Item,
  ItemSchemaConfig,
  LLMResponse,
  LlmProviderConfig,
  OnSteerParams,
  PendingSpend,
  ProjectionPolicy,
  RecallLayerOutput,
  RecallOptions,
  ReconcileSpendOptions,
  SessionScope,
  SessionUsage,
  ShellAdapter,
  Span,
  SpendSettlement,
  SteeringDecision,
  SteerVerdict,
  Step,
  StepArray,
  StepArrayInput,
  StepArrayOutput,
  Steps,
  StorageAdapter,
  StreamEvent,
  StreamingItem,
  SubprocessAdapter,
  Tool,
  ToolApprover,
  TraceExporter,
  UsageCharge,
  WriteOffSpendOptions,
  ZodType,
} from './deps/types';
import { SteeringAction } from './deps/types';
import { AgentHarnessModelCaller, noLlmProviderError } from './model-call';
import type { SpendClient } from './spend';
import { DISPATCH_HEADER, GENERATION_HEADER, Spend } from './spend';
import { ThreadRecord } from './thread-record';

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
   * Defaults to a store over `adapter` when one is given, so configuring durable
   * storage is enough for a later harness on the same storage to resume this one's
   * executions (see the harness `durability` option to turn that off). With no
   * adapter and no store, checkpoint/restore are no-ops — a zero-config harness keeps
   * its ephemeral semantics.
   */
  checkpointStore?: CheckpointStore;
  /** Layer-state store override. Defaults to an in-memory store. */
  layerStateStore?: LayerStateStore;
  /**
   * Bounds on the step-completion ledger that backs step-level resume. Only meaningful
   * when durability is on (a `checkpointStore`, given or defaulted). Defaults to `DEFAULT_STEP_LEDGER_RETENTION` — 128 KiB
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
  /** Resolves `secret()` names immediately before a connection call is sent (spec 35 § Secrets). */
  secrets?: SecretResolver;
  /** Where binary content is stored (spec 08 § Artifact Store). Defaults to an in-memory store. */
  artifacts?: ArtifactStore;
}

interface AgentHarnessOpts<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TItem extends CustomItem = CustomItem,
> {
  name: string;
  /**
   * Root step tree executed for every turn submitted via `execute()`. The custom items
   * it declares (a `workflow()` step's brand) type `getItemStream`, `getFullStream`,
   * and `getAgentResponse` (spec 34).
   */
  agentGraph?: Steps<ContextData, string, string> & CustomItemsBrand<TItem>;
  /** Default context layers applied to every context created via `createContext()` / `execute()`. */
  contextLayers?: ContextLayer[];
  /**
   * Whether runs and sessions are durable: checkpointed, recorded to the step ledger,
   * and resumable on a later harness over the same storage. Defaults to true whenever
   * `environment.storage` gives an adapter or a checkpoint store. `false` turns every
   * durability surface off even then — the adapter still backs context-layer
   * persistence.
   */
  durability?: boolean;
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
  /** Default model for `decide` steps. */
  decisionModel?: string;
  /**
   * Whether a resumed run streams again the items its replayed steps emitted
   * (`step.emitItems`), as `item_appended`. Defaults to `false`: a replay rebuilds the
   * log quietly. Set it when a client that reconnects to a resumed run should see
   * the progress it missed.
   */
  emitItemsOnReplay?: boolean;
  /**
   * Approves or refuses calls to tools that declare `needsApproval`, after the
   * `beforeToolCall` layers allow them. Without one, those calls run
   * unapproved and the harness warns once per tool name.
   */
  approveToolCall?: ToolApprover;
  /**
   * The live things the agent works with — browsers, devices, apps, chat workspaces,
   * sources — by name (spec 35). Providers connect in `start()`.
   */
  connections?: ConnectionsConfig;
  /** Connection events that start or join a turn (spec 35 § Triggers). */
  triggers?: ReadonlyArray<ConnectionTrigger>;
  /** The verifier `step.verify` uses (spec 37). */
  verification?: Verifier;
  /** @internal Test-only escape hatch to inject a mock callModel implementation. */
  _testCallModel?: (request: CallModelRequest) => Promise<LLMResponse>;
  /** @internal Test-only escape hatch to inject a mock decide implementation. */
  _testDecide?: (request: DecideRequest) => Promise<DecideResponse>;
}

interface Session {
  readonly runner: SessionRunner;
  /** The thread's history between turns. Used only when durability is off. */
  accumulatedItems: Item[];
  /** The thread's stored session, when durability is on — then the only record. */
  readonly record?: ThreadRecord;
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
  http?: HTTPClient,
): OpenRouter | undefined {
  const resolved = resolveLlmClient(config, readLlmEnv());
  if (!resolved) {
    return undefined;
  }
  const options: {
    apiKey: string;
    serverURL?: string;
    httpClient?: ClientOptions['httpClient'];
  } = {
    apiKey: resolved.apiKey,
  };
  if (resolved.serverURL) {
    options.serverURL = resolved.serverURL;
  }
  if (http) {
    // The agent bundles an older SDK whose `HTTPClient` class is nominally different;
    // the agent calls only `request()` on it, which both versions share.
    options.httpClient = frameworkCast<ClientOptions['httpClient']>(http);
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

type ClientOptions = NonNullable<ConstructorParameters<typeof OpenRouter>[0]>;

/**
 * An HTTP client that saves a paid call's generation id the moment its headers
 * arrive. The SDK awaits the hook before it reads the body, so a call cut off after
 * its headers can still be priced. Both the model client and the decisions client
 * send through it; requests without a dispatch header pass untouched.
 */
function generationHook(spend: Spend): HTTPClient {
  return new HTTPClient().addHook('response', async (res, req) => {
    const dispatchId = req.headers.get(DISPATCH_HEADER);
    const generationId = res.headers.get(GENERATION_HEADER);
    // An error response is retried or refused; only a success carries the call's id.
    if (res.ok && dispatchId && generationId) {
      await spend.noteGeneration(dispatchId, generationId);
    }
  });
}

function createSdkClient(config?: LlmProviderConfig, http?: HTTPClient): OpenRouterSdk | undefined {
  const resolved = resolveLlmClient(config, readLlmEnv());
  if (!resolved) {
    return undefined;
  }
  return new OpenRouterSdk({
    apiKey: resolved.apiKey,
    serverURL: resolved.serverURL,
    ...(http
      ? {
          httpClient: http,
        }
      : {}),
  });
}

/**
 * The checkpoint store a harness runs with: the one given, else a store over the
 * configured storage adapter, so durable storage alone turns resume on. None when
 * the harness sets `durability: false`.
 */
function resolveCheckpointStore(
  storage: StorageEnvironmentConfig | undefined,
  durability: boolean | undefined,
): CheckpointStore | undefined {
  if (durability === false) {
    return undefined;
  }
  if (storage?.checkpointStore) {
    return storage.checkpointStore;
  }
  return storage?.adapter
    ? createCheckpointStore({
        storage: storage.adapter,
      })
    : undefined;
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
export class AgentHarness<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TItem extends CustomItem = never,
> implements AgentHarnessContract<TParams>
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
   * (a `CheckpointStore` is configured or defaulted), so a zero-config harness records
   * nothing.
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
  /**
   * SDK 1.x client for the endpoints the agent's client predates: decisions, model
   * prices, and generation lookups.
   */
  private readonly sdkClient?: OpenRouterSdk;
  /**
   * Paid dispatch records, present exactly when durability is on.
   * @internal
   */
  readonly spend?: Spend;
  private readonly decideOverride?: (request: DecideRequest) => Promise<DecideResponse>;
  /** Model id → whether it answers natively as a decision model. */
  private readonly decisionModels = new Map<string, Promise<boolean>>();
  /** @internal Channel state; read by the checkpoint functions. */
  readonly channelStore: ChannelStore;
  /**
   * Root contexts with a `run()` in flight, keyed by id, with their
   * re-entrant run depth — see `executeClosingChannels`.
   */
  private readonly liveRoots = new Map<
    string,
    {
      ctx: Context;
      depth: number;
      /** Epoch ms the outermost run began. */
      startedAt: number;
      /** Whether any run on this root threw, so the run's start stays the resume point. */
      failed: boolean;
      /** Settles once the outermost run has rebuilt the context and fixed its start. */
      ready: Promise<void>;
    }
  >();
  /** Stored sessions for `execute()` threads. Present exactly when durability is on. */
  private readonly sessionStore?: SessionStore;
  /** Checkpoint capture in flight per execution id — see `saveCheckpoint`. */
  private readonly pendingCheckpoints = new Map<string, Promise<boolean>>();
  private readonly callModelOverride?: (request: CallModelRequest) => Promise<LLMResponse>;
  private readonly defaultDeliveryMode: DeliveryMode;
  private readonly sessions = new Map<string, Session>();
  /**
   * @internal Live ACP connections. Reached by the interpreter via
   * `frameworkCast`; use {@link listAcpSessions}, {@link getAcpSession},
   * {@link cancelAcpSession}, and {@link closeAcpSessions} from outside core.
   */
  readonly acpSessions = new AcpSessionStore();
  /** @internal Graceful stops in progress; the interpreter and model loop hold on them. */
  readonly drains = new Drains();
  /** Where binary content is stored: `environment.artifacts`, else an in-memory store. */
  readonly artifacts: ArtifactStore;
  // Connection state lives in true private fields: anything holding `ctx.harness`
  // must not reach the registry or the secret resolver (spec 35 § Gates, § Secrets).
  // Core modules read the registry and verifier through `harnessInternal`.
  readonly #connections?: HarnessConnections;
  /** Roots whose connection needs are already registered or checked. */
  readonly #negotiatedRoots = new WeakSet<object>();

  /**
   * Snapshot of every live ACP sub-agent, for a UI that wants to show what is
   * running and let a user act on it. Read-only: a session's turns are driven
   * by steps, so nothing here can start work behind the runtime's back.
   * @public
   */
  listAcpSessions(): AcpSessionInfo[] {
    return this.acpSessions.list();
  }

  /**
   * The live connection + session behind a handle from {@link listAcpSessions}
   * (or a step's `session.reuse` key), or `undefined` when nothing matches.
   * @public
   */
  getAcpSession(key: string): AcpLiveSession | undefined {
    return this.acpSessions.get(key);
  }

  /**
   * Interrupt whatever the sub-agent under `key` is doing, via `session/cancel`.
   * The connection stays open and the turn still returns — with the `cancelled`
   * stop reason, which the running step surfaces as a `cancelled` error.
   * Returns false when nothing matches the key.
   * @public
   */
  async cancelAcpSession(key: string): Promise<boolean> {
    const entry = this.acpSessions.get(key);
    if (!entry) {
      return false;
    }
    await entry.session.cancel();
    return true;
  }

  /**
   * Close every ACP connection this harness still holds, whatever its
   * keep-alive scope. A connection owns a live agent — usually a child process
   * whose stdio keeps the event loop alive — so a `keepAlive: 'harness'`
   * session must be closed by its owner or the host will not exit. Idempotent.
   * @public
   */
  async closeAcpSessions(): Promise<void> {
    await this.acpSessions.closeAll();
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
  /** Executions restored from a checkpoint: their first layer init keeps the restored state. */
  private readonly restoredExecutions = new Set<string>();
  /**
   * Layer hooks still running per context. `cancel()` waits for them before
   * `onComplete`/`dispose`, so teardown never races a half-finished `store`
   * or `recall`. Each hook is bounded by its own timeout.
   */
  private readonly runningHooks = new WeakMap<Context, Set<Promise<unknown>>>();
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

  constructor(opts: AgentHarnessOpts<TParams, TItem>) {
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
      decisionModel: opts.decisionModel,
      emitItemsOnReplay: opts.emitItemsOnReplay,
      approveToolCall: opts.approveToolCall,
    };
    this.fs = environment?.fs ?? createInMemoryFsAdapter();
    this.shell = environment?.shell ?? createInMemoryShellAdapter();
    this.subprocess = environment?.subprocess ?? createInMemorySubprocessAdapter();
    this.checkpointStore = resolveCheckpointStore(storageEnv, opts.durability);
    this.stepLedgerStore = this.checkpointStore
      ? createStepLedgerStore({
          storage: this.config.storage ?? createInMemoryStorage(),
        })
      : undefined;
    this.stepLedgerRetention = resolveStepLedgerRetention(storageEnv?.stepLedgerRetention);
    this.sessionStore = this.checkpointStore
      ? createSessionStore(this.config.storage ?? createInMemoryStorage())
      : undefined;
    this.spend = this.checkpointStore
      ? this.createSpend(this.config.storage ?? createInMemoryStorage())
      : undefined;
    this.agentGraph = opts.agentGraph ? toStep(opts.agentGraph) : undefined;
    this.harnessTools = opts.tools ?? [];
    this._contextLayers = opts.contextLayers;
    this.callModelOverride = opts._testCallModel;
    const http = this.spend ? generationHook(this.spend) : undefined;
    this.client = opts._testCallModel
      ? undefined
      : createClient(opts.callModelDefaults, opts.contextCache, http);
    this.decideOverride = opts._testDecide;
    this.sdkClient = opts._testCallModel
      ? undefined
      : createSdkClient(opts.callModelDefaults, http);
    this.channelStore = new ChannelStore({
      onWarning: (warning) => this.recordChannelWarning(warning),
    });
    this.traceExporter = opts.traceExporter ?? new NoopExporter();
    this.layerStateStore =
      storageEnv?.layerStateStore ??
      createLayerStateStore((layerId, hook, error) => {
        console.warn(`[noetic] context layer '${layerId}' ${hook} error:`, error);
      });
    this.recallCache = createRecallCache();
    this.contextCache = createContextCacheStore();
    this.defaultDeliveryMode = opts.defaultDeliveryMode ?? 'next-turn';
    // The graph's custom items join before any log is restored or rebuilt (spec 34).
    this.itemSchemas = new ItemSchemaRegistry(opts.itemSchemas?.schemas, {
      strictUnknownExtensions: opts.itemSchemas?.strict ?? true,
    }).extend({
      items: customItemGates([
        ...(this.agentGraph
          ? collectCustomItems(frameworkCast<Step>(this.agentGraph)).map((item) => item.type)
          : []),
        ...(opts.triggers && opts.triggers.length > 0
          ? [
              CONNECTION_EVENT_ITEM_TYPE,
            ]
          : []),
      ]),
    });
    this.rootCwdState = {
      cwd: opts.initialCwd ?? '/',
    };
    this.artifacts = environment?.artifacts ?? createInMemoryArtifactStore();
    if (opts.connections || (opts.triggers && opts.triggers.length > 0)) {
      this.#connections = createHarnessConnections({
        harness: this,
        connections: opts.connections,
        triggers: opts.triggers,
        storage: this.config.storage ?? createInMemoryStorage(),
        artifacts: this.artifacts,
        secrets: environment?.secrets,
        broadcasters: () =>
          [
            ...this.sessions.values(),
          ].map((session) => session.runner.broadcaster),
      });
    }
    setHarnessInternals(this, {
      connectionRegistry: this.#connections?.registry,
      verifier: opts.verification,
    });
    if (this.#connections) {
      this.registerGraphNeeds(this.#connections.registry);
    }
  }

  /**
   * Registers what the agent graph's handles need: their profiles (ref kinds) and
   * requirements, negotiated at start and again on every manifest change
   * (spec 35 § Connection registry). Names the harness lacks are left to fail
   * with `CONNECTION_UNKNOWN` when the step runs.
   */
  private registerGraphNeeds(registry: ConnectionRuntime): void {
    if (!this.agentGraph) {
      return;
    }
    this.#negotiatedRoots.add(this.agentGraph);
    const known = new Set(registry.names());
    for (const need of graphConnectionNeeds(frameworkCast<Step>(this.agentGraph))) {
      if (need.profile) {
        registry.registerProfile(need.profile);
      }
      if (known.has(need.name)) {
        registry.require(need.name, need.requirement);
      }
    }
  }

  /**
   * Negotiates a `run()` root that is not the agent graph, once per root, after
   * the providers have connected: registers its handles' profiles and checks its
   * requirements against each connection's manifest, so a root that needs more
   * than a connection offers fails before it executes, as a document does
   * (spec 35 § Negotiation).
   *
   * @throws `NoeticConfigError` `CONNECTION_UNSATISFIED` when a connection falls short.
   */
  private negotiateRoot(root: Step): void {
    const registry = this.#connections?.registry;
    if (!registry || this.#negotiatedRoots.has(root)) {
      return;
    }
    const known = new Set(registry.names());
    for (const need of graphConnectionNeeds(root)) {
      if (need.profile) {
        registry.registerProfile(need.profile);
      }
      if (known.has(need.name)) {
        registry.check(need.name, need.requirement);
      }
    }
    this.#negotiatedRoots.add(root);
  }

  /**
   * Connects every connection provider and starts triggers. The first `execute()`
   * or `run()` calls it; call it yourself for a harness that only reacts to
   * triggers. Idempotent.
   * @public
   */
  async start(): Promise<void> {
    await this.#connections?.start();
  }

  /**
   * Each connection's state, identity and pool usage; one entry for `name`, or all.
   * @public
   */
  getConnectionStatus(name?: string): ReadonlyArray<ConnectionStatus> {
    return this.#connections?.registry.status(name) ?? [];
  }

  /**
   * Shuts down everything the harness holds open: stops triggers, releases
   * every connection and pool lease, and closes every ACP session. Call it when
   * the host is done with the harness; anything left open can keep the process
   * alive. Idempotent.
   * @public
   */
  async close(): Promise<void> {
    await this.#connections?.close();
    await this.closeAcpSessions();
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
    if (this.lacksModelFor(this.agentGraph)) {
      return Promise.reject(noLlmProviderError());
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
      void session.runner.abort(INTERRUPT_REASON);
      return Promise.resolve();
    }

    const steersRunningTurn = session.runner.getStatus().kind === 'generating' && isSteer(message);
    session.runner.enqueue(message);
    if (steersRunningTurn) {
      void session.record?.keepSteer(message);
    }
    return Promise.resolve();
  }

  /** The turn's response. `items` holds final items: standard ones and the graph's declared custom items. */
  getAgentResponse(
    scope?: SessionScope,
  ): Promise<HarnessResponse<Item | CustomItemOf<DeclaredItems<TItem>>>> {
    const session = this.requireSession(scope);
    return frameworkCast(session.runner.getAgentResponse());
  }

  /**
   * Item snapshots as they stream. A declared custom item streams like a model reply:
   * each event in progress (`isComplete: false`), then its final item, under one `id`.
   */
  getItemStream(
    scope?: SessionScope,
  ): AsyncIterable<StreamingItem | CustomStreamingItem<DeclaredItems<TItem>>> {
    const session = this.requireSession(scope);
    return frameworkCast(buildItemStream(session.runner.broadcaster, this.itemSchemas));
  }

  getTextStream(scope?: SessionScope): AsyncIterable<string> {
    const session = this.requireSession(scope);
    return filterTextStream(session.runner.broadcaster);
  }

  getReasoningStream(scope?: SessionScope): AsyncIterable<string> {
    const session = this.requireSession(scope);
    return filterReasoningStream(session.runner.broadcaster);
  }

  /** Every event raw, including each declared custom item's `custom_item_event`. */
  getFullStream(
    scope?: SessionScope,
  ): AsyncIterable<StreamEvent | CustomItemStreamEvent<DeclaredItems<TItem>>> {
    const session = this.requireSession(scope);
    return session.runner.broadcaster;
  }

  async abort(scope?: SessionScope & CancelOptions): Promise<DrainReport | undefined> {
    const threadId = scope?.threadId ?? DEFAULT_THREAD_ID;
    const session = this.sessions.get(threadId);
    if (!session) {
      return undefined;
    }
    const { runner } = session;
    const ctx = runner.context;
    if (!ctx) {
      await runner.abort(scope?.reason);
      return undefined;
    }
    const draining = this.drains.stop(ctx);
    if (draining) {
      return draining;
    }
    if (!scope?.drainMs) {
      await runner.abort(scope?.reason);
      return undefined;
    }
    // The drained turn may end on its own; then the runner has moved on and
    // there is nothing left to abort.
    return this.drains.run(ctx, scope.drainMs, async () => {
      if (runner.context === ctx) {
        await runner.abort(scope.reason);
      }
    });
  }

  getStatus(scope: ExecutionScope): ExecutionStatus;
  getStatus(scope?: SessionScope): HarnessStatus;
  getStatus(scope?: SessionScope | ExecutionScope): HarnessStatus | ExecutionStatus {
    if (scope && 'executionId' in scope) {
      return this.executionStatus(scope.executionId);
    }
    const threadId = scope?.threadId ?? DEFAULT_THREAD_ID;
    const session = this.sessions.get(threadId);
    if (!session) {
      return {
        kind: 'idle',
      };
    }
    const status = session.runner.getStatus();
    const ctx = session.runner.context;
    const drain = ctx && this.drains.covering(ctx);
    if (status.kind !== 'generating' || !drain) {
      return status;
    }
    return {
      kind: 'draining',
      turnId: status.turnId,
      deadline: drain.deadline,
    };
  }

  /**
   * A `run()` execution's state, read from its live root context. Only a root
   * context's outermost run registers, so a context nothing runs on reads idle.
   */
  private executionStatus(executionId: string): ExecutionStatus {
    const live = this.liveRoots.get(executionId);
    if (!live) {
      return {
        kind: 'idle',
      };
    }
    if (live.ctx.aborted) {
      return {
        kind: 'aborting',
      };
    }
    const drain = this.drains.covering(live.ctx);
    if (drain) {
      return {
        kind: 'draining',
        deadline: drain.deadline,
      };
    }
    return {
      kind: 'generating',
      startedAt: live.startedAt,
    };
  }

  getQueueSize(scope?: SessionScope): number {
    const threadId = scope?.threadId ?? DEFAULT_THREAD_ID;
    const session = this.sessions.get(threadId);
    return session ? session.runner.queue.size : 0;
  }

  getUsage(scope?: SessionScope): SessionUsage {
    const threadId = scope?.threadId ?? DEFAULT_THREAD_ID;
    const usage = this.sessions.get(threadId)?.runner.getUsage() ?? {
      inputTokens: 0,
      outputTokens: 0,
    };
    const heldCost = this.spend?.heldFor(threadId) ?? 0;
    return heldCost > 0
      ? {
          ...usage,
          heldCost,
        }
      : usage;
  }

  seedSessionHistory(threadId: string, items: ReadonlyArray<Item>): void {
    const session = this.getOrCreateSession(threadId);
    if (session.record) {
      // Queued ahead of any turn on this thread, so the next turn reads it back.
      void session.record.seed(items);
      return;
    }
    session.accumulatedItems = [
      ...items,
    ];
  }

  private getOrCreateSession(threadId: string): Session {
    const existing = this.sessions.get(threadId);
    if (existing) {
      return existing;
    }

    const record = this.threadRecord(threadId);
    // Save a turn's items as the thread's history for the next turn.
    const keepHistory = async (ctx: Context): Promise<void> => {
      if (record) {
        await record.end(
          ctx,
          ctx.itemLog.items,
          session.runner.queue.peekAll().map((message) => message.id),
        );
        return;
      }
      session.accumulatedItems = [
        ...ctx.itemLog.items,
      ];
    };
    const session: Session = {
      accumulatedItems: [],
      record,
      runner: new SessionRunner({
        threadId,
        agentName: this.config.name,
        // The first queued message in a batch establishes `resourceId` /
        // `state` / `context` for the turn. If multiple messages are drained
        // together (queue flush), later messages' values for these fields
        // are ignored. `deliveryMode` is resolved per-message at enqueue
        // time and doesn't apply here.
        createContext: async (items, _turnId, messages) => {
          const perTurnOptions: ExecuteOptions = messages[0]?.options ?? {};
          const messageIds = messages.map((m) => m.id);
          const history = record ? await record.history() : session.accumulatedItems;
          // A re-delivery of a cut-off turn's messages picks that turn up where it died.
          const resumed = await record?.resume(messageIds, {
            state: perTurnOptions.state,
            contextLayers: perTurnOptions.contextLayers,
            _broadcaster: session.runner.broadcaster,
          });
          const ctx =
            resumed ??
            this.createContext({
              items: [
                ...history,
                ...items,
              ],
              threadId,
              resourceId: perTurnOptions.resourceId,
              state: perTurnOptions.state,
              contextLayers: perTurnOptions.contextLayers,
              extraContextLayers: perTurnOptions.extraContextLayers,
              _broadcaster: session.runner.broadcaster,
            });
          frameworkCast<Context & SessionCtxExtension>(ctx)._sessionQueue = session.runner.queue;
          await this.start();
          const connectionTools = this.#connections?.tools() ?? [];
          if (this.agentGraph || this.harnessTools.length > 0 || connectionTools.length > 0) {
            const stepTools = this.agentGraph ? collectAllTools(this.agentGraph) : [];
            this.setUnifiedTools(ctx, [
              ...stepTools,
              ...this.harnessTools,
              ...connectionTools,
            ]);
          }
          // Steers the last harness accepted but never applied go back in the queue;
          // ones already in the conversation are skipped when offered.
          for (const steer of (await record?.steers()) ?? []) {
            const queued = session.runner.queue.peekAll().some((m) => m.id === steer.id);
            if (!queued && !messageIds.includes(steer.id)) {
              session.runner.queue.enqueue(steer);
            }
          }
          await record?.begin(ctx, messageIds);
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
          const result = await this.initAndRun(this.agentGraph, '', ctx).catch(
            async (error: unknown) => {
              // An interrupted turn restarts from what it finished, so the
              // interrupting message lands after the work it interrupted.
              if (ctx.abortReason === INTERRUPT_REASON) {
                await keepHistory(ctx);
              }
              throw error;
            },
          );
          await keepHistory(ctx);
          return result;
        },
        // Stored totals are the session's usage; the runner only mirrors them.
        onTurnUsage: record
          ? async (spent) => {
              session.runner.seedUsage(await record.addUsage(spent));
            }
          : undefined,
      }),
    };

    this.sessions.set(threadId, session);
    if (record) {
      void record.usage().then((usage) => session.runner.seedUsage(usage));
    }
    return session;
  }

  /** The stored record for `threadId`, when durability is on. */
  private threadRecord(threadId: string): ThreadRecord | undefined {
    if (!this.sessionStore) {
      return undefined;
    }
    return new ThreadRecord(
      {
        store: this.sessionStore,
        restore: (executionId, opts) => this.restore(executionId, opts),
        clearCheckpoint: (executionId) => this.clearCheckpoint(executionId),
        parseItems: (raw) => this.itemSchemas.parseMany(raw),
      },
      threadId,
    );
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
      spend: this.spend,
    }).callModel(request);
  }

  //#endregion

  //#region decide

  async decide(request: DecideRequest): Promise<DecideResponse> {
    if (this.decideOverride) {
      return this.decideOverride(request);
    }
    return callDecide(request, {
      client: this.sdkClient,
      callModel: (r) => this.callModel(r),
      nativeModels: this.decisionModels,
      spend: this.spend,
    });
  }

  async notifyDecision(
    layers: ContextLayer[],
    record: DecisionRecord,
    ctx: Context,
  ): Promise<void> {
    await this.trackHook(
      ctx,
      notifyDecision({
        layers,
        record,
        ctx: this.toExecCtx(ctx),
        store: this.layerStateStore,
        recallCache: this.recallCache,
      }),
    );
  }

  //#endregion

  /**
   * Runs a step — or an array of steps in sequence, each output the next one's
   * input (an array runs its steps in sequence everywhere in Noetic).
   */
  run<I, O>(step: Step<ContextData, I, O>, input: I, ctx: Context): Promise<O>;
  run<const T extends StepArray>(
    steps: T,
    input: StepArrayInput<T>,
    ctx: Context,
  ): Promise<StepArrayOutput<T>>;
  async run<I, O>(s: Steps<ContextData, I, O>, input: I, ctx: Context): Promise<O> {
    const root = toStep<ContextData, I, O>(s);
    if (this.lacksModelFor(root)) {
      throw noLlmProviderError();
    }
    // Populate the unified tool pool when an embedder drives a step directly on
    // a bare `createContext()` context (the turn pipeline does this per turn).
    // Without it, steps that resolve tools dynamically from `ctx.unifiedTools`
    // — and any sub-agents spawned from them — would see no tools.
    await this.start();
    this.negotiateRoot(frameworkCast<Step>(root));
    if (!ctx.unifiedTools) {
      this.setUnifiedTools(ctx, [
        ...collectAllTools(root),
        ...this.harnessTools,
        ...(this.#connections?.tools() ?? []),
      ]);
    }
    // Hydrate/recall/persist context on the bare `run()` path too (issue #48):
    // configuring `context` + `storage` must "just work" without going through
    // `execute()`/`seedSessionHistory`. Idempotent — see `ensureLayersInit`.
    await this.ensureLayersInit(ctx);
    return this.executeClosingChannels(root, input, ctx);
  }

  /**
   * Whether `step` calls a model this harness has no credentials for. Checked
   * before any step runs so a missing provider fails fast instead of after
   * earlier steps' side effects. Steps the walk cannot see (dynamic branches)
   * still hit the same error lazily at their model call.
   */
  private lacksModelFor<I, O>(step: Step<ContextData, I, O>): boolean {
    if (this.client || this.callModelOverride) {
      return false;
    }
    return someStep(
      frameworkCast<Step>(step),
      (s) => s.kind === 'callModel' || (s.kind === 'decide' && !this.decideOverride),
    );
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
    const live = this.liveRoots.get(ctx.id);
    const entry = live ?? {
      ctx,
      depth: 0,
      startedAt: Date.now(),
      failed: false,
      ready: Promise.resolve(),
    };
    entry.depth += 1;
    this.liveRoots.set(ctx.id, entry);
    if (!live) {
      // A restored or sequentially re-run root context reuses its id — clear
      // any closure from a previous completion so its channels work again.
      this.channelStore.openExecution(ctx.id);
      entry.ready = this.beginDurableRun(ctx).then(() => this.reconcileConnections(ctx));
    }
    try {
      await entry.ready;
      return await execute(s, input, ctx);
    } catch (error) {
      entry.failed = true;
      throw error;
    } finally {
      entry.depth -= 1;
      if (entry.depth <= 0) {
        this.liveRoots.delete(ctx.id);
        this.channelStore.closeExecution(ctx.id);
        await this.acpSessions.closeOwnedBy(ctx.id);
        if (entry.failed) {
          // A failed run keeps its pool leases, unrenewed, so a resume within the
          // reclaim window gets the same connections back and an abandoned one
          // frees them (spec 35 § Pools and leases).
          this.#connections?.registry.orphanRun?.(ctx.id);
        } else {
          await this.#connections?.registry.releaseRun(ctx.id);
          await this.endDurableRun(ctx);
        }
      }
    }
  }

  /**
   * Fix the point a resume of this run starts from, and queue it for saving — so even
   * a run whose first step dies leaves a snapshot to restore. The save is not awaited:
   * the steps' own checkpoints queue behind it.
   *
   * When the context's last run never finished, the run repeats it, and it does so
   * from storage — the stored baseline and ledger — exactly as a new harness resuming
   * the execution would, not from what the failed attempt left in memory.
   */
  private async beginDurableRun(ctx: Context): Promise<void> {
    if (!this.checkpointStore || !(ctx instanceof ContextImpl)) {
      return;
    }
    if (ctx.hasUnfinishedRun()) {
      await this.rebuildFromStorage(ctx);
    }
    ctx.beginRun();
    void this.saveCheckpoint(ctx);
  }

  /**
   * Before a resumed run replays anything, checks the connections its ledger and
   * pending entries were recorded against, discarding the ledger from the first
   * entry whose connection was replaced (spec 35 § Durability).
   *
   * @throws NoeticErrorImpl `connection_resume_refused` when a replaced connection is unsafe to drive again.
   */
  private async reconcileConnections(ctx: Context): Promise<void> {
    const registry = this.#connections?.registry;
    if (!registry || !(ctx instanceof ContextImpl) || !ctx.ledger) {
      return;
    }
    await reconcileResumedConnections({
      ctx,
      registry,
      storage: this.config.storage,
      signal: ctx.abortSignal,
    });
  }

  /**
   * Stand `ctx` at its stored baseline and give it the stored ledger. Without a
   * snapshot (its save failed), the baseline the context fixed in memory when the run
   * began is the best record left.
   */
  private async rebuildFromStorage(ctx: ContextImpl): Promise<void> {
    await this.pendingCheckpoints.get(ctx.id);
    const snapshot = await this.checkpointStore?.load(ctx.id).catch(() => null);
    ctx.allowItemTypes(snapshot?.customItemTypes ?? []);
    const itemSchemas = ctx.itemSchemas ?? this.itemSchemas;
    ctx.rebase(
      snapshot
        ? {
            items: itemSchemas.parseMany(snapshot.itemLog.items),
            occurrences: snapshot.occurrences,
          }
        : ctx.runBaseline(),
    );
    const recovered = await this.stepLedgerStore?.load(ctx.id);
    if (recovered) {
      ctx.ledger?.adopt(recovered);
    }
  }

  /**
   * A finished run is the next run's starting point: persist the live log and counts,
   * then drop the run's positional ledger entries, which no later resume can reach.
   * They are kept when the snapshot failed to land, since that snapshot still points
   * at this run's start. A failed run skips this entirely — it is what a resume repeats.
   */
  private async endDurableRun(ctx: Context): Promise<void> {
    if (!this.checkpointStore || !(ctx instanceof ContextImpl)) {
      return;
    }
    ctx.endRun();
    if (await this.saveCheckpoint(ctx)) {
      await ctx.ledger?.dropPaths();
    }
    if (this.config.storage) {
      await clearPendingEntries(this.config.storage, ctx.id);
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
    const keep = this.restoredExecutions.delete(ctx.id);
    await initLayers({
      layers,
      ctx: this.toExecCtx(ctx),
      storage,
      store: this.layerStateStore,
      keep,
    });
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
    /** Charge this context's usage to `parent` as it is spent. Default `true`. */
    rollUpUsage?: boolean;
    items?: Item[];
    state?: unknown;
    threadId?: string;
    resourceId?: string;
    contextLayers?: ContextLayer[];
    /** Additional layers appended AFTER the effective set — never replaces it. */
    extraContextLayers?: ContextLayer[];
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
    const { contextLayers, extraContextLayers, cwdInit, ...rest } = resolved;
    const configuredLayers = contextLayers ?? this._contextLayers;
    const views = this.#connections?.views ?? [];
    const baseLayers =
      views.length > 0
        ? [
            ...(configuredLayers ?? []),
            ...views,
          ]
        : configuredLayers;
    const effectiveLayers =
      extraContextLayers && extraContextLayers.length > 0
        ? [
            ...(baseLayers ?? []),
            ...extraContextLayers,
          ]
        : baseLayers;
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

  send<T>(channel: Channel<T>, value: NoInfer<T>, ctx: Context): Promise<void> {
    // Internal sender: back-pressured on full queue channels. The calling
    // context's abort signal rejects a parked send with 'cancelled'.
    const signal = ctx instanceof ContextImpl ? ctx.abortSignal : undefined;
    this.channelStore.claim(channel, rootIdOf(ctx));
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
    this.channelStore.claim(channel, rootIdOf(ctx));
    return this.channelStore.recv(channel, opts?.timeout, signal);
  }

  tryRecv<T>(channel: Channel<T>, ctx: Context): T | null {
    this.channelStore.claim(channel, rootIdOf(ctx));
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
    return this.trackHook(
      ctx,
      recallLayers({
        layers,
        query: input,
        ctx: this.toExecCtx(ctx),
        log: ctx.itemLog,
        budgets: this.layerBudgets(layers),
        store: this.layerStateStore,
        itemSchemas: this.itemSchemas,
      }),
    );
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
    opts?: RecallOptions,
  ): Promise<RecallLayerOutput[]> {
    return this.trackHook(
      ctx,
      recallLayersAtomic({
        layers,
        query: input,
        ctx: this.toExecCtx(ctx),
        log: ctx.itemLog,
        budgets,
        store: this.layerStateStore,
        itemSchemas: this.itemSchemas,
        forceAtomic: this.config.forceAtomicRecall,
        peek: opts?.peek,
      }),
    );
  }

  async recallLayersEventual(
    layers: ContextLayer[],
    input: string,
    ctx: Context,
    budgets: Map<string, number>,
    opts?: RecallOptions,
  ): Promise<RecallLayerOutput[]> {
    return this.trackHook(
      ctx,
      recallLayersEventual({
        layers,
        query: input,
        ctx: this.toExecCtx(ctx),
        log: ctx.itemLog,
        budgets,
        store: this.layerStateStore,
        itemSchemas: this.itemSchemas,
        forceAtomic: this.config.forceAtomicRecall,
        cache: this.recallCache,
        peek: opts?.peek,
      }),
    );
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
    const record = existingSession?.record ?? this.threadRecord(threadId);
    const historyItems: Item[] = record
      ? await record.history()
      : [
          ...(existingSession?.accumulatedItems ?? []),
        ];
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
    await this.trackHook(
      ctx,
      storeLayers({
        layers,
        response,
        ctx: this.toExecCtx(ctx),
        log: ctx.itemLog,
        store: this.layerStateStore,
        storage,
        recallCache: this.recallCache,
      }),
    );
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
    await this.saveCheckpoint(ctx);
  }

  /**
   * Capture `ctx` behind any capture still in flight for the same execution, and
   * resolve true when this one landed. Every step in the tree checkpoints its root,
   * and concurrent paths would otherwise race their writes: on a networked adapter an
   * older snapshot could land last and win.
   */
  private saveCheckpoint(ctx: Context): Promise<boolean> {
    const prior = this.pendingCheckpoints.get(ctx.id);
    const next = (prior ?? Promise.resolve(true)).then(() => captureCheckpoint(this, ctx));
    this.pendingCheckpoints.set(ctx.id, next);
    void next.finally(() => {
      if (this.pendingCheckpoints.get(ctx.id) === next) {
        this.pendingCheckpoints.delete(ctx.id);
      }
    });
    return next;
  }

  /**
   * Rebuild a `Context` from what a previous run of `executionId` recorded: its
   * checkpoint snapshot, its step-completion ledger, or both. Without a snapshot the
   * context starts empty (no item log or layer state) but keeps the execution id and
   * ledger, so recorded steps replay and the rest run fresh. Returns `null` when
   * neither is recorded — start a fresh execution. Surface a typed
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
   *
   * Paid calls the interrupted run left with no settled bill are held on the
   * returned context (`heldCost`) and reconciled in the background.
   */
  async restore(
    executionId: string,
    opts?: RestoreCheckpointOptions & {
      /**
       * Connections the restored run may drive again live although they were
       * replaced since it stopped — the way past `connection_resume_refused` for
       * a connection whose determinism is `unsafe` (spec 35 § Durability).
       * Applies to this restore only; it ends when the run does.
       */
      readonly rerun?: ReadonlyArray<string>;
    },
  ): Promise<Context | null> {
    const { rerun, ...restoreOptions } = opts ?? {};
    if (rerun && rerun.length > 0) {
      this.#connections?.registry.allowRerun(executionId, rerun);
    }
    const restored = await restoreFromCheckpoint(this, executionId, restoreOptions);
    if (!restored) {
      return null;
    }
    if (restored.fromSnapshot) {
      this.restoredExecutions.add(executionId);
    }
    await this.spend?.adopt(restored.ctx);
    return restored.ctx;
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

  //#region Spend

  /**
   * Paid provider calls with no settled bill — cut off by a crash, a cancel, a steer,
   * or a dropped connection — all of them or one execution's, each with its ceiling.
   * A record that no longer reads is listed as `unreadable`, with no ceiling, until
   * written off. A call still in flight in this harness is not listed. Empty without
   * durable storage. See spec 23 § Paid dispatches.
   * @public
   */
  async pendingSpend(executionId?: string): Promise<PendingSpend[]> {
    return (await this.spend?.pending(executionId)) ?? [];
  }

  /**
   * Price pending dispatches through the provider's generation lookup and settle
   * them into usage. The provider prices a call some seconds after it ends, so this
   * keeps asking for up to `patienceMs`. A dispatch with no generation id stays held.
   * Runs on its own after `restore()` and whenever a call is cut off; call it again
   * at any time, for example at boot.
   * @public
   */
  async reconcileSpend(opts?: ReconcileSpendOptions): Promise<SpendSettlement[]> {
    return (await this.spend?.reconcile(opts)) ?? [];
  }

  /**
   * Settle one pending dispatch at `assumedCost`, for a call that can never be priced,
   * unreadable ones included. Resolves `undefined` when no pending dispatch has that id.
   * @public
   */
  async writeOffSpend(
    id: string,
    opts: WriteOffSpendOptions,
  ): Promise<SpendSettlement | undefined> {
    return this.spend?.writeOff(id, opts);
  }

  private createSpend(storage: StorageAdapter): Spend {
    return new Spend({
      agentName: this.config.name,
      log: createSpendLog(storage),
      client: (): SpendClient | undefined => this.sdkClient,
      liveRoot: (executionId) => this.liveRoots.get(executionId)?.ctx,
      chargeSession: (threadId, charge) => this.chargeSession(threadId, charge),
      sessionBroadcaster: (threadId) => this.sessions.get(threadId)?.runner.broadcaster,
    });
  }

  /** Add a settled bill to a thread's stored session. False when the thread has none. */
  private async chargeSession(threadId: string, charge: UsageCharge): Promise<boolean> {
    if (!(await this.sessionStore?.load(threadId))) {
      return false;
    }
    // The live session's own record, when there is one, so the two writes queue in order.
    const record = this.sessions.get(threadId)?.record ?? this.threadRecord(threadId);
    if (!record) {
      return false;
    }
    const usage = await record.addUsage({
      inputTokens: charge.inputTokens,
      outputTokens: charge.outputTokens,
      cost: charge.cost ?? 0,
      billedCost: charge.billedCost ?? charge.cost ?? 0,
    });
    this.sessions.get(threadId)?.runner.seedUsage(usage);
    return true;
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
   * settle (up to its timeout) before that context's teardown, and step code that ignores `ctx.aborted` between `await`s runs to
   * its next boundary. Calling `cancel()` on an already-cancelled context is a
   * no-op.
   *
   * With `{ drainMs }` the cancel is graceful: nothing new starts beneath
   * `ctx`, model calls in flight get up to `drainMs` to finish and be charged,
   * and `{name}:drain_started` / `{name}:drain_finished` report which finished
   * and which were cut off. A second `cancel` during the drain cancels at once.
   * Either call resolves with the drain's report, the same data as
   * `drain_finished`; a cancel with no drain resolves `undefined`.
   */
  async cancel(ctx: Context, options?: string | CancelOptions): Promise<DrainReport | undefined> {
    const { reason, drainMs }: CancelOptions =
      typeof options === 'string'
        ? {
            reason: options,
          }
        : (options ?? {});
    const draining = this.drains.stop(ctx);
    if (draining) {
      return draining;
    }
    if (ctx.aborted) {
      return undefined;
    }
    if (drainMs) {
      return this.drains.run(ctx, drainMs, () => this.cancelNow(ctx, reason));
    }
    await this.cancelNow(ctx, reason);
    return undefined;
  }

  /** Abort `ctx`'s tree and tear its layers down. The abort happens before the first `await`. */
  private async cancelNow(ctx: Context, reason: string | undefined): Promise<void> {
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
   * Run the layer lifecycle's abort path for one cancelled context: wait for
   * its in-flight layer hooks to settle, then `onComplete` with
   * `outcome: 'aborted'`, then `dispose`. Both always run under cancellation
   * (spec 09, Cancellation item 6).
   */
  private async teardownCancelledContext(ctx: Context): Promise<void> {
    const layers = ctx.layers ?? [];
    if (layers.length === 0) {
      return;
    }
    await Promise.allSettled(this.runningHooks.get(ctx) ?? []);
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

  /**
   * Channel state is shared by every root on this harness, so a channel
   * warning is recorded as a `channel.warning` event on each live root's
   * span (spec 10). A root span counts only if it will reach the trace
   * exporter — a harness span (`SpanImpl`) with a real exporter configured.
   * With no such span the warning goes to the console, so it is never lost.
   */
  private recordChannelWarning(warning: ChannelWarning): void {
    const traced =
      this.traceExporter instanceof NoopExporter
        ? []
        : [
            ...this.liveRoots.values(),
          ].filter(({ ctx }) => ctx.span instanceof SpanImpl);
    if (traced.length === 0) {
      warnToConsole(warning);
      return;
    }
    for (const { ctx } of traced) {
      ctx.span.addEvent(NoeticEvent.CHANNEL_WARNING, {
        ...warning,
      });
    }
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
    callId?: string,
  ): Promise<SteeringDecision> {
    const hasHook = layers.some((l) => l.hooks.beforeToolCall);
    if (!hasHook) {
      return {
        action: SteeringAction.Allow,
      };
    }
    return this.trackHook(
      ctx,
      beforeToolCallLayers({
        layers,
        toolName,
        toolArgs,
        callId,
        ctx: this.toExecCtx(ctx),
        store: this.layerStateStore,
      }),
    );
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
    return this.trackHook(
      ctx,
      afterModelCallLayers({
        layers,
        response,
        ctx: this.toExecCtx(ctx),
        store: this.layerStateStore,
      }),
    );
  }

  async onSteer(
    layers: ContextLayer[],
    params: Pick<OnSteerParams, 'steer' | 'point' | 'action' | 'pendingCalls'>,
    ctx: Context,
  ): Promise<SteerVerdict> {
    return this.trackHook(
      ctx,
      onSteerLayers({
        layers,
        ...params,
        ctx: this.toExecCtx(ctx),
        store: this.layerStateStore,
      }),
    );
  }

  /** Record `hook` as running on `ctx` until it settles (see `runningHooks`). */
  private trackHook<T>(ctx: Context, hook: Promise<T>): Promise<T> {
    let running = this.runningHooks.get(ctx);
    if (!running) {
      running = new Set();
      this.runningHooks.set(ctx, running);
    }
    running.add(hook);
    const forget = (): void => {
      running.delete(hook);
    };
    hook.then(forget, forget);
    return hook;
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
