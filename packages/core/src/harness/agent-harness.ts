import type {
  ApproveRequest,
  ArtifactStore,
  ConnectionStatus,
  ConnectionTrigger,
  DecisionItem,
  ExecuteArgument,
  HeldCall,
  HeldResolution,
  StuckTurn,
  TrailMark,
} from '@noetic-tools/types';
import {
  CONNECTION_EVENT_ITEM_TYPE,
  frameworkCast,
  ItemSchemaRegistry,
  isDecisionItem,
  isNoeticError,
  NoeticConfigError,
  NoeticErrorImpl,
} from '@noetic-tools/types';
import { toStep } from '../builders/sequence';
import { runEvery } from '../connections/settle';
import { pendingTasksOf, resumableWaitsOf } from '../interpreter/connection-steps';
import { turnEndingIn } from '../interpreter/turn-ending';
import { AcpSessionStore } from '../runtime/acp-session-store';
import { emitFrameworkEvent, getBroadcaster } from '../runtime/broadcaster-utils';
import { stubOf } from '../runtime/durable/step-ledger';
import { heldCallsOf, toHeldCall } from '../runtime/held-calls';
import type { OutputSnapshot } from '../runtime/output-store';
import { OutputStore } from '../runtime/output-store';
import { awaitApproval } from '../runtime/tool-approval';
import { ConnectionGate } from './connection-gate';
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
  isRootRunning,
  prepareBandedView,
  runRootOf,
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
  TurnLeaseOptions,
} from './deps/runtime';
import {
  buildItemStream,
  ChannelStore,
  ContextImpl,
  canSwap,
  captureCheckpoint,
  clearCheckpoint,
  collectContextTree,
  createInMemoryStorage,
  createSessionStore,
  createSpendLog,
  createStepLedgerStore,
  customItemGates,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_PARK_GRACE_MS,
  Drains,
  filterReasoningStream,
  filterTextStream,
  heldElsewhere,
  heldElsewhereUntil,
  INTERRUPT_REASON,
  isSteer,
  PARK_REASON,
  resolveStepLedgerRetention,
  restoreFromCheckpoint,
  rootIdOf,
  SessionRunner,
  StepLedger,
  snapshotCwdState,
  TurnLease,
} from './deps/runtime';
import type {
  AcpLiveSession,
  AcpSessionInfo,
  AgentConfig,
  AgentHarnessContract,
  CallModelRequest,
  CancelOptions,
  Channel,
  ChannelHandle,
  Context,
  ContextCacheStore,
  ContextData,
  ContextLayer,
  CustomItem,
  CustomItemOf,
  CustomItemStreamEvent,
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
  LLMResponse,
  OnSteerParams,
  PendingSpend,
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
  StepLike,
  Steps,
  StepsInput,
  StepsOutput,
  StorageAdapter,
  StreamEvent,
  StreamingItem,
  SubprocessAdapter,
  Tool,
  TraceExporter,
  UsageCharge,
  ValidStepChain,
  WriteOffSpendOptions,
} from './deps/types';
import { SteeringAction } from './deps/types';
import { flowVersionOf } from './flow-version';
import type {
  AgentHarnessOpts,
  ParkConfig,
  TurnLeaseConfig,
  WakeTimeListener,
} from './harness-options';
import { resolveCheckpointStore, resolveEnvironmentAdapters } from './harness-options';
import { createHarnessSpan, recordChannelWarning, resolveTraceExporter } from './harness-tracing';
import { LlmGateway } from './llm-client';
import { buildItemSchemaRegistry } from './model-schema';
import { DEFAULT_TASK_POLL_MS, DEFAULT_WAKE_DEBOUNCE_MS, ParkWatchers } from './park-watchers';
import type { ReadDecision } from './read-decision';
import { readDecision } from './read-decision';
import type { SpendClient } from './spend';
import { Spend } from './spend';
import { ThreadRecord } from './thread-record';

//#region Types

interface Session {
  /** The delivery in progress on this thread, which the next one waits behind. */
  delivering?: Promise<void>;
  readonly runner: SessionRunner;
  /** The thread's history between turns. Used only when durability is off. */
  accumulatedItems: Item[];
  /** The thread's stored session, when durability is on — then the only record. */
  readonly record?: ThreadRecord;
  /** The lease the turn in flight runs under, when storage can compare-and-set. */
  lease?: TurnLease;
  /** The `execute()` options of the turn in flight, to resume it with if it parks. */
  turnOptions?: ExecuteOptions;
  /**
   * The options of messages kept in storage for after a parked turn, by message
   * id. Options hold live objects (layers, connections) storage cannot, so they
   * wait here; a message another process picks up keeps its `resourceId` only.
   */
  readonly keptOptions: Map<string, ExecuteOptions>;
}

/** Keep `message` in storage for after the thread's parked turn, with its options. */
function keepForLater(
  session: Session,
  record: ThreadRecord,
  message: QueuedMessage,
): Promise<void> {
  session.keptOptions.set(message.id, message.options);
  return record.keepQueued(message);
}

//#endregion

const DEFAULT_THREAD_ID = '__default__';

/** What a `turn_stuck` error says about where the turn stopped, or undefined for any other error. */
function stuckOf(error: unknown):
  | {
      path: string;
      from: string;
      to: string;
    }
  | undefined {
  const ending = turnEndingIn(error)?.noeticError;
  if (ending?.kind !== 'turn_stuck') {
    return undefined;
  }
  const { path, from, to } = ending;
  return {
    path,
    from,
    to,
  };
}

/** True when `execute()` was handed a list. `Array.isArray` does not narrow a readonly one. */
function isItemList(
  input: Exclude<ExecuteArgument, string>,
): input is ReadonlyArray<Item | DecisionItem> {
  return Array.isArray(input);
}

function isLeaseLost(error: unknown): boolean {
  return isNoeticError(error) && error.noeticError.kind === 'lease_lost';
}

/** Added to the lease period for the default wait on a held lease. */
const LEASE_WAIT_MARGIN_MS = 1e3;

/** What a turn's run resolves to when it parked instead of finishing. */
const PARKED: unique symbol = Symbol('parked');

/** When the turn on `ctx` parked until, or undefined when it did not park. */
function parkedUntil(ctx: Context): number | undefined {
  if (ctx.abortReason !== PARK_REASON || !(ctx instanceof ContextImpl)) {
    return undefined;
  }
  return ctx.ledger?.parking.parkedUntil;
}

/** The grace before a turn parks, or undefined when parking is off. */
function resolveParkGrace(park: boolean | ParkConfig | undefined): number | undefined {
  if (!park) {
    return undefined;
  }
  return park === true ? DEFAULT_PARK_GRACE_MS : (park.graceMs ?? DEFAULT_PARK_GRACE_MS);
}

/** Lease settings for sessions on `storage`, or none when it cannot compare-and-set. */
function resolveLeaseOptions(
  storage: StorageAdapter | undefined,
  config: TurnLeaseConfig | undefined,
): TurnLeaseOptions | undefined {
  if (!canSwap(storage)) {
    return undefined;
  }
  const ttlMs = config?.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  // One lease period, and a little more: a dead holder's lease runs out in that time.
  const waitMs = config?.waitMs ?? ttlMs + LEASE_WAIT_MARGIN_MS;
  // A lease of no length is lost before the turn's first write; one that never
  // ends is never taken over.
  const ttlOk = Number.isFinite(ttlMs) && ttlMs > 0;
  const waitOk = Number.isFinite(waitMs) && waitMs >= 0;
  if (!ttlOk || !waitOk || config?.holder === '') {
    throw new NoeticConfigError({
      code: 'INVALID_LEASE_OPTIONS',
      message: `environment.storage.lease is not usable: ttlMs ${ttlMs}, waitMs ${waitMs}, holder ${JSON.stringify(config?.holder)}.`,
      hint: 'Give ttlMs a finite number of milliseconds above 0, waitMs a finite number from 0 up, and holder a non-empty name, or leave them out for the defaults.',
    });
  }
  return {
    storage,
    holder: config?.holder ?? crypto.randomUUID(),
    ttlMs,
    waitMs,
    now: config?.now ?? Date.now,
  };
}
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
  /** Provider clients and the model / decision calls made through them. */
  private readonly llm: LlmGateway;
  /**
   * Paid dispatch records, present exactly when durability is on.
   * @internal
   */
  readonly spend?: Spend;
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
  /** Set when sessions are durable and storage can compare-and-set. */
  private readonly leaseOptions?: TurnLeaseOptions;
  /** The flow version this harness runs, when the host names one. */
  private readonly version?: string;
  /** Set when turns park (`environment.storage.park`): the grace before one does. */
  private readonly parkGraceMs?: number;
  /** Set when this harness wakes the turns it parked (`park.autoWake`). */
  private readonly parkWatchers?: ParkWatchers;
  /** Who hears when the next wake time changes (`onWakeTimeChange`). */
  private readonly wakeTimeListeners = new Set<WakeTimeListener>();
  /** The wake time listeners last heard; `null` until they have heard one. */
  private announcedWakeTime: number | undefined | null = null;
  /** The announcement in flight, so two never run out of order. */
  private announcing: Promise<void> = Promise.resolve();
  /** Checkpoint capture in flight per execution id — see `saveCheckpoint`. */
  private readonly pendingCheckpoints = new Map<string, Promise<boolean>>();
  private readonly defaultDeliveryMode: DeliveryMode;
  private readonly sessions = new Map<string, Session>();
  /** Whether threads keep their streamed output for display (`opts.interactive`). */
  readonly interactive: boolean;
  /** Where display output is kept: the harness's storage, or memory without one. */
  private readonly outputStorage: StorageAdapter;
  /** The display output each thread of an interactive harness records, by thread id. */
  private readonly outputs = new Map<string, OutputStore>();
  /** Thread id → what stops recording it. */
  private readonly stopRecording = new Map<string, () => void>();
  /** Threads named by a host-built context's own id, dropped when its run ends. */
  private readonly ownThreads = new Set<string>();
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
  // Connection state lives in a true private field: anything holding `ctx.harness`
  // must not reach the registry or the secret resolver (spec 35 § Gates, § Secrets).
  // Core modules read the registry and verifier through `harnessInternal`.
  readonly #connections: ConnectionGate;

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
    this.interactive = opts.interactive ?? false;
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
      now: opts.now,
      killAgentsOnExit: opts.killAgentsOnExit,
    };
    this.outputStorage = this.config.storage ?? createInMemoryStorage();
    const adapters = resolveEnvironmentAdapters(environment);
    this.fs = adapters.fs;
    this.shell = adapters.shell;
    this.subprocess = adapters.subprocess;
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
    this.leaseOptions = resolveLeaseOptions(this.sessionStore ? this.config.storage : undefined, {
      now: opts.now,
      ...storageEnv?.lease,
    });
    this.parkGraceMs = resolveParkGrace(this.leaseOptions ? storageEnv?.park : undefined);
    this.parkWatchers = this.createParkWatchers(storageEnv?.park);
    this.spend = this.checkpointStore
      ? this.createSpend(this.config.storage ?? createInMemoryStorage())
      : undefined;
    this.agentGraph = opts.agentGraph ? toStep(opts.agentGraph) : undefined;
    this.version = opts.version ?? flowVersionOf(frameworkCast<Step | undefined>(this.agentGraph));
    this.harnessTools = opts.tools ?? [];
    this._contextLayers = opts.contextLayers;
    this.llm = new LlmGateway({
      agentName: opts.name,
      providerConfig: opts.callModelDefaults,
      contextCache: opts.contextCache,
      spend: this.spend,
      callModelOverride: opts._testCallModel,
      decideOverride: opts._testDecide,
      streamIdleTimeoutMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    });
    this.channelStore = new ChannelStore({
      onWarning: (warning) => this.recordChannelWarning(warning),
    });
    this.traceExporter = resolveTraceExporter(opts.traceExporter);
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
        // Always known: a trigger can be added while the harness runs, and one added
        // on an earlier run comes back from storage, so its turns must be able to
        // carry the event.
        CONNECTION_EVENT_ITEM_TYPE,
      ]),
    });
    this.rootCwdState = {
      cwd: opts.initialCwd ?? '/',
    };
    this.artifacts = adapters.artifacts;
    this.#connections = new ConnectionGate({
      harness: this,
      connections: opts.connections,
      triggers: opts.triggers,
      onSchedule: () => this.announceWakeTimeQuietly(),
      storage: this.config.storage ?? createInMemoryStorage(),
      artifacts: this.artifacts,
      secrets: environment?.secrets,
      verifier: opts.verification,
      broadcasters: () =>
        [
          ...this.sessions.values(),
        ].map((session) => session.runner.broadcaster),
    });
    this.#connections.registerGraphNeeds(
      this.agentGraph ? frameworkCast<Step>(this.agentGraph) : undefined,
    );
  }

  /**
   * Connects every connection provider and starts triggers. The first `execute()`
   * or `run()` calls it; call it yourself for a harness that only reacts to
   * triggers. Idempotent.
   * @public
   */
  async start(): Promise<void> {
    await this.#connections.start();
    // Once started, a scheduled source's next event is known: say when it is.
    if (this.announcedWakeTime === null) {
      await this.announceWakeTime();
    }
  }

  /**
   * Hear when `getNextWakeTime()` changes: a turn parks, resumes or ends, a
   * trigger is added or removed, or a scheduled source's event is read. `listener`
   * gets the new time, or `undefined` when there is nothing to wake for. The first
   * call comes when the harness starts. A host with no process of its own between
   * events sets its alarm from it.
   *
   * The harness waits for the listener before a parking turn answers, and a
   * listener that throws there fails that turn's response: a turn nothing will
   * wake must not look safely parked. Anywhere else a throw is logged.
   *
   * It does not replace the harness's own timer (`park.autoWake`).
   *
   * @returns a function that stops the listener hearing.
   * @public
   */
  onWakeTimeChange(listener: WakeTimeListener): () => void {
    this.wakeTimeListeners.add(listener);
    return () => {
      this.wakeTimeListeners.delete(listener);
    };
  }

  /** Tell the listeners the next wake time, when it is not the one they last heard. */
  private announceWakeTime(): Promise<void> {
    if (this.wakeTimeListeners.size === 0) {
      return Promise.resolve();
    }
    const run = this.announcing.then(async () => {
      const at = await this.getNextWakeTime();
      if (at === this.announcedWakeTime) {
        return;
      }
      for (const listener of this.wakeTimeListeners) {
        await listener(at);
      }
      this.announcedWakeTime = at;
    });
    this.announcing = run.catch(() => undefined);
    return run;
  }

  /** `announceWakeTime`, where a listener's failure has no turn to land on. */
  private async announceWakeTimeQuietly(): Promise<void> {
    try {
      await this.announceWakeTime();
    } catch (error) {
      console.warn('[noetic] onWakeTimeChange listener error:', error);
    }
  }

  /**
   * Resolves once the harness has nothing in hand: every scheduled event that is
   * due has been read by its trigger, and every turn has finished or parked. A
   * serverless host awaits it after `start()` and `wake()`, before it lets its
   * process go.
   * @public
   */
  async waitForIdle(): Promise<void> {
    for (;;) {
      await this.#connections.triggers.idle();
      const busy = [
        ...this.sessions.values(),
      ].filter((session) => session.runner.getStatus().kind !== 'idle');
      if (busy.length === 0) {
        return;
      }
      await Promise.allSettled(busy.map((session) => session.runner.getAgentResponse()));
    }
  }

  /**
   * Each connection's state, identity and pool usage; one entry for `name`, or all.
   * @public
   */
  getConnectionStatus(name?: string): ReadonlyArray<ConnectionStatus> {
    return this.#connections.status(name);
  }

  /**
   * Shuts down everything the harness holds open: stops triggers, releases
   * every connection and pool lease, and closes every ACP session. Call it when
   * the host is done with the harness; anything left open can keep the process
   * alive. Everything is closed even when one part throws; the first failure is
   * then rethrown. Idempotent.
   * @public
   */
  async close(): Promise<void> {
    this.parkWatchers?.stopAll();
    await runEvery([
      ...[
        ...this.outputs.values(),
      ].map((output) => () => output.flush()),
      () => this.#connections.close(),
      () => this.closeAcpSessions(),
    ]);
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

  /**
   * Hand the thread a message, a person's decision, or both.
   *
   * A {@link DecisionItem} answers a tool call the thread's turn holds, or settles
   * its stuck turn. It is not written to the conversation, and input that holds
   * nothing else starts no turn: the turn the decision is for goes on.
   *
   * Several decisions in one list are read first, so a malformed one changes
   * nothing, and then taken in order: one the thread's state refuses throws, and
   * those before it stay taken. `options` reach the turn a decision resumes.
   *
   * @throws NoeticError `hold_refused` when an answer to a held call cannot be
   *   taken: the thread holds no such call, `argsHash` names other arguments, the
   *   answer is the wrong kind for the hold, the call was already answered
   *   differently, its `output` is not a JSON value, or a `function_call_output`
   *   item names a held call.
   * @throws NoeticError `decision_refused` when a decision does not fit what the
   *   thread is waiting on: no turn is stuck, it carries both an `action` and an
   *   `output`, or its action is the wrong kind for a decision with, or without,
   *   a `callId`.
   * @public
   */
  async execute(input: ExecuteArgument, options?: ExecuteOptions): Promise<void> {
    const message = await this.takeDecisions(input, options);
    if (message === undefined) {
      return;
    }
    return this.deliverInput(message, options);
  }

  /**
   * Act on the decisions in `input` and resolve what is left of it: the message to
   * deliver, or undefined when the input was decisions only.
   *
   * Every decision is read before any is acted on, so a list with a malformed one
   * changes nothing. They are then acted on in order: one the thread's state
   * refuses throws, and those before it stay taken.
   */
  private async takeDecisions(
    input: ExecuteArgument,
    options: ExecuteOptions | undefined,
  ): Promise<ExecuteInput | undefined> {
    if (typeof input === 'string') {
      return input;
    }
    const threadId = options?.threadId ?? DEFAULT_THREAD_ID;
    const given = isItemList(input)
      ? input
      : [
          input,
        ];
    const rest: Item[] = [];
    const decisions: ReadDecision[] = [];
    for (const item of given) {
      if (isDecisionItem(item)) {
        decisions.push(readDecision(threadId, item));
        continue;
      }
      rest.push(item);
    }
    await this.refuseResultsForHeldCalls(threadId, rest);
    for (const decision of decisions) {
      await this.takeDecision(decision, options);
    }
    if (rest.length === given.length) {
      return frameworkCast<ExecuteInput>(input);
    }
    return rest.length === 0 ? undefined : rest;
  }

  /**
   * A held call's result comes in a decision. A `function_call_output` for one
   * would go into the conversation and leave the call waiting, so it is refused.
   */
  private async refuseResultsForHeldCalls(threadId: string, items: Item[]): Promise<void> {
    const outputs = items.filter((item) => item.type === 'function_call_output');
    if (outputs.length === 0) {
      return;
    }
    const held = new Set(
      (
        await this.pending({
          threadId,
        })
      ).map((call) => call.callId),
    );
    for (const item of outputs) {
      if ('callId' in item && typeof item.callId === 'string' && held.has(item.callId)) {
        throw new NoeticErrorImpl({
          kind: 'hold_refused',
          callId: item.callId,
          reason: "a held call's result is given in a decision item, not a function_call_output",
        });
      }
    }
  }

  /** Act on one decision: an answer to a held call, or the settling of a stuck turn. */
  private async takeDecision(
    decision: ReadDecision,
    options: ExecuteOptions | undefined,
  ): Promise<void> {
    if ('answer' in decision) {
      await this.resolveHeld(decision.scope, decision.answer, options);
      return;
    }
    if (await this.settleStuckTurn(decision.threadId, decision.settle, options)) {
      return;
    }
    throw new NoeticErrorImpl({
      kind: 'decision_refused',
      threadId: decision.threadId,
      action: decision.settle,
      reason: 'the thread has no stuck turn',
    });
  }

  private deliverInput(input: ExecuteInput, options?: ExecuteOptions): Promise<void> {
    if (!this.agentGraph) {
      return Promise.reject(
        new NoeticConfigError({
          code: 'NO_STEP_CONFIGURED',
          message: 'No agentGraph configured on this harness.',
          hint: 'Pass `agentGraph` in constructor options, or use run() directly.',
        }),
      );
    }
    const missingModel = this.llm.missingModelFor(this.agentGraph);
    if (missingModel) {
      return Promise.reject(missingModel);
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

    return this.deliver(session, message);
  }

  /**
   * Hand a message to its thread. One at a time per thread: what to do with a
   * message is decided by looking at the thread and then acting, and two
   * deliveries doing that at once would each miss the other.
   */
  private deliver(session: Session, message: QueuedMessage): Promise<void> {
    const turn = (session.delivering ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.deliverOne(session, message));
    session.delivering = turn;
    return turn;
  }

  private async deliverOne(session: Session, message: QueuedMessage): Promise<void> {
    if (await this.deliverToParked(session, message)) {
      return;
    }
    if (await this.answerAgain(session, message)) {
      return;
    }
    if (await this.inHand(session, message)) {
      return;
    }
    const steersRunningTurn = session.runner.getStatus().kind === 'generating' && isSteer(message);
    session.runner.enqueue(message);
    if (steersRunningTurn) {
      void session.record?.keepSteer(message);
      // A round waiting on a held call offers the steer to the layers at once.
      const running = session.runner.context;
      if (running) {
        heldCallsOf(this).notify(rootIdOf(running));
      }
    }
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

  /**
   * A thread's display output (spec 08 § Display output): the latest snapshot of
   * every item it streamed, unfinished ones included, read from storage. An
   * `interactive` harness records it; any harness over the same storage reads it.
   * For showing a thread again, never for resuming one.
   *
   * @throws OutputStoreError when storage fails, or holds something else under the key.
   * @public
   */
  getSessionOutput(scope?: SessionScope): Promise<OutputSnapshot[]> {
    return this.outputOf(scope?.threadId ?? DEFAULT_THREAD_ID).read();
  }

  /**
   * Save display snapshots for a thread, each replacing the stored one with its
   * id, and resolve the thread's whole display output. For a protocol adapter
   * that shows a thread in its own item shapes. Model history is untouched.
   *
   * @throws OutputStoreError when `items` are not snapshots (objects with a string
   *   `type`), or storage fails.
   * @public
   */
  saveSessionOutput(items: ReadonlyArray<unknown>, scope: SessionScope): Promise<OutputSnapshot[]> {
    return this.outputOf(scope.threadId ?? DEFAULT_THREAD_ID).write(items);
  }

  /**
   * The thread's one output store: every write for a thread goes through it, so
   * this harness's writes queue behind each other instead of racing.
   */
  private outputOf(threadId: string): OutputStore {
    const known = this.outputs.get(threadId);
    if (known) {
      return known;
    }
    const output = new OutputStore(this.outputStorage, threadId, this.itemSchemas);
    this.outputs.set(threadId, output);
    return output;
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
    // A parked turn lives in storage, so a harness that never ran the thread can
    // still be the one asked to abort it.
    const session =
      this.sessions.get(threadId) ??
      (this.sessionStore ? this.getOrCreateSession(threadId) : undefined);
    if (!session) {
      return undefined;
    }
    const { runner } = session;
    const ctx = runner.context;
    if (!ctx) {
      await runner.abort(scope?.reason);
      // Nothing is running, but a parked turn is still the thread's turn: drop it,
      // or the next wake would bring back what the host just cancelled.
      await runner.whenIdle();
      if ((await session.record?.turn())?.parked) {
        this.parkWatchers?.stop(threadId);
        await session.record?.drop();
        await this.announceWakeTimeQuietly();
      }
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
    const keepHistory = async (ctx: Context, answer?: string): Promise<void> => {
      if (record) {
        // A finished turn's answer is kept, so its messages delivered again get it back.
        if (answer !== undefined) {
          await record.answered(ctx, answer);
        }
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
      keptOptions: new Map(),
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
          // One harness drives a thread's turn: take its lease before reading anything.
          const lease =
            record && this.leaseOptions
              ? await TurnLease.take(this.leaseOptions, threadId, {
                  // Aborting the thread ends the wait for a lease held elsewhere.
                  signal: session.runner.signal,
                  // A lease record that was deleted must not start again below the
                  // term the thread's own record was last written at.
                  above: await record.term(),
                })
              : undefined;
          record?.hold(lease);
          session.lease = lease;
          try {
            if (record && (await this.setAside(session, record, messages))) {
              await this.releaseLease(session);
              return undefined;
            }
            return await buildTurnContext(items, messages, lease);
          } catch (error) {
            await this.releaseLease(session);
            throw error;
          }
        },
        runTurn: async (ctx, _turn, signal) => {
          try {
            return await runTurn(ctx, signal);
          } finally {
            await this.releaseLease(session);
            // An answer that landed while this harness still held the lease could not
            // wake the turn. Now that it is free, do that.
            if (parkedUntil(ctx) !== undefined) {
              void this.wakeIfAnswered(threadId, ctx.id);
            }
          }
        },
        heldCalls: async (ctx) =>
          (await heldCallsOf(this).list(rootIdOf(ctx)))
            .filter((held) => held.resolution === undefined)
            .map(toHeldCall),
        // Stored totals are the session's usage; the runner only mirrors them.
        onTurnUsage: record
          ? async (spent) => {
              session.runner.seedUsage(await record.addUsage(spent));
            }
          : undefined,
      }),
    };

    const buildTurnContext = async (
      items: ReadonlyArray<Item>,
      messages: ReadonlyArray<QueuedMessage>,
      lease: TurnLease | undefined,
    ): Promise<Context> => {
      const perTurnOptions: ExecuteOptions = messages[0]?.options ?? {};
      // The turn is starting or resuming here: nothing needs to watch over it.
      session.turnOptions = perTurnOptions;
      this.parkWatchers?.stop(threadId);
      const messageIds = messages.map((m) => m.id);
      const history = record ? await record.history() : session.accumulatedItems;
      const graph = this.agentGraph ? frameworkCast<Step>(this.agentGraph) : undefined;
      const views = this.#connections.turnViews(perTurnOptions.connections, graph);
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
          _connectionViews: views.layers,
          _broadcaster: session.runner.broadcaster,
        });
      if (lease) {
        lease.bind(ctx.id);
        if (ctx instanceof ContextImpl) {
          ctx.ledger?.fence(lease);
        }
        lease.keep((reason) => ctx.abort(`lease_lost: ${reason}`));
        if (this.parkGraceMs !== undefined && ctx instanceof ContextImpl) {
          ctx.ledger?.parking.arm({
            graceMs: this.parkGraceMs,
            onPark: () => ctx.abort(PARK_REASON),
          });
        }
      }
      // A resumed context was made without the turn's view layers.
      if (!resumed) {
        views.bind(ctx);
      }
      frameworkCast<Context & SessionCtxExtension>(ctx)._sessionQueue = session.runner.queue;
      await this.start();
      const connectionTools = await this.#connections.openTurn(
        ctx,
        perTurnOptions.connections,
        graph,
      );
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
          // With the options it was sent with, when this process is the one it was sent to.
          const options = session.keptOptions.get(steer.id) ?? steer.options;
          session.keptOptions.delete(steer.id);
          session.runner.queue.enqueue({
            ...steer,
            options,
          });
        }
      }
      // A stuck turn the host chose to go on with may discard what no longer matches.
      const accept = (await record?.turn())?.accept;
      if (accept && ctx instanceof ContextImpl) {
        ctx.ledger?.acceptVersionLoss(typeof accept === 'string' ? accept : undefined);
      }
      await record?.begin(ctx, messageIds);
      // A turn on record can be cut off from here on. A host that sleeps between
      // requests has to know when to come back and look (see `turnDueAt`).
      if (record && this.leaseOptions) {
        await this.announceWakeTimeQuietly();
      }
      return ctx;
    };

    /**
     * A parked turn is not a failed one: its record stays, marked with when to wake
     * it, and the response says so. Resolves true when the turn on `ctx` parked.
     */
    const closeOutPark = async (ctx: Context): Promise<boolean> => {
      const wakeAt = parkedUntil(ctx);
      if (wakeAt === undefined || !record) {
        return false;
      }
      // Messages still queued wait in storage, not in this process: the woken
      // turn gets them back, and the runner is left with nothing to start.
      const interrupts: QueuedMessage[] = [];
      for (const queued of session.runner.queue.drainAll()) {
        if (queued.deliveryMode === 'interrupt') {
          interrupts.push(queued);
          continue;
        }
        await keepForLater(session, record, queued);
      }
      // An interrupt replaces the turn, parked or not: it stays for the runner to start.
      for (const interrupt of interrupts.reverse()) {
        session.runner.queue.prepend(interrupt);
      }
      const until = Number.isFinite(wakeAt) ? wakeAt : undefined;
      await record.park(ctx, until);
      await this.#connections.release(ctx.id);
      this.parkWatchers?.watch(threadId, {
        executionId: ctx.id,
        until,
        options: session.turnOptions ?? {},
      });
      // Before the turn answers as parked: whoever wakes it has to know when.
      await this.announceWakeTime();
      return true;
    };

    const runTurn = async (ctx: Context, signal: AbortSignal): Promise<string> => {
      if (!this.agentGraph) {
        await this.#connections.release(ctx.id);
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
        async (error: unknown): Promise<typeof PARKED> => {
          // An interrupted turn restarts from what it finished, so the
          // interrupting message lands after the work it interrupted.
          if (ctx.abortReason === INTERRUPT_REASON) {
            await keepHistory(ctx);
          }
          // A parked turn is not a failed one: its record stays, marked with when
          // to wake it, and the response says so.
          if (await closeOutPark(ctx)) {
            return PARKED;
          }
          // The turn ended here, in a live process. Say so, or a routine wake would
          // take it for one cut off by a crash and run it again, every time.
          // It stopped rather than redo a recorded effect under a newer flow version:
          // it waits, marked, for the host to settle it.
          const stuck = stuckOf(error);
          if (record && stuck) {
            await record.stick(ctx, stuck);
            await this.announceWakeTimeQuietly();
            throw error;
          }
          // A harness that was replaced says nothing about the turn: it is the new
          // holder's now, and marking it stopped would keep a wake from resuming it.
          const replaced = isLeaseLost(error) || session.lease?.lost === true;
          if (ctx.aborted && !replaced && ctx.abortReason !== INTERRUPT_REASON) {
            await heldCallsOf(this).clear(ctx.id);
          }
          if (record && !replaced && ctx.abortReason !== INTERRUPT_REASON) {
            await record.stop(
              ctx,
              error instanceof Error ? error.message : String(error),
              this.now(),
            );
          }
          await this.announceWakeTimeQuietly();
          throw error;
        },
      );
      // A flow that caught the wait's cancellation and returned is parked all the
      // same: the wait it was in has not ended, and the woken turn goes back to it.
      if (result === PARKED || (await closeOutPark(ctx))) {
        return '';
      }
      await keepHistory(ctx, result);
      this.parkWatchers?.forget(threadId, ctx.id);
      await this.announceWakeTimeQuietly();
      return result;
    };

    if (this.interactive) {
      const output = this.outputOf(threadId);
      this.stopRecording.set(
        threadId,
        session.runner.broadcaster.observe((event) => output.record(event)),
      );
    }
    this.sessions.set(threadId, session);
    if (record) {
      void record.usage().then((usage) => session.runner.seedUsage(usage));
    }
    return session;
  }

  /**
   * Resume turns that are parked or were cut off (spec 23 § Parked turns).
   *
   * With no `threadId`, every stored thread is looked at: a parked turn is resumed
   * once its wake time has come, and a cut-off turn at once. With a `threadId`, that
   * thread's turn is resumed whether or not it is due — the call a host makes when
   * it knows the event a parked turn waits for has arrived. A turn another harness
   * holds, or one already running here, is left alone.
   *
   * A resumed turn replays what it finished and goes on. `options` are the
   * `execute()` options it runs with; a stored turn keeps none of its own.
   *
   * Resolves the ids of the threads it resumed. Durable sessions only.
   * @public
   */
  async wake(scope?: { threadId?: string; options?: ExecuteOptions }): Promise<string[]> {
    if (!this.sessionStore) {
      return [];
    }
    const now = this.now();
    const threadIds = scope?.threadId
      ? [
          scope.threadId,
        ]
      : await this.sessionStore.threads();
    const woken: string[] = [];
    for (const threadId of threadIds) {
      // A turn asked for by name may be closing out its park this instant: its
      // runner is busy, though nothing is running. Wait for it rather than skip.
      const closing = scope?.threadId ? this.sessions.get(threadId)?.runner : undefined;
      if (closing && closing.context === undefined) {
        await closing.whenIdle();
      }
      const turn = (await this.sessionStore.load(threadId))?.turn;
      // A stuck turn waits for the host to settle it, however the wake was asked for.
      if (!turn || turn.stuck) {
        continue;
      }
      // A routine wake leaves alone a parked turn that is not due, one with no
      // deadline at all (it waits for an answer, not for a time), and one that
      // failed or was cancelled here: only a turn cut off by a crash resumes unasked.
      const notDue = turn.parked && (turn.parked.until === undefined || turn.parked.until > now);
      if (!scope?.threadId && (notDue || (turn.stopped && !turn.parked))) {
        // A parked turn found in storage, as at boot, is watched over from here on.
        if (turn.parked && this.parkWatchers && !this.parkWatchers.has(threadId)) {
          this.parkWatchers.watch(threadId, {
            executionId: turn.executionId,
            until: turn.parked.until,
            options: scope?.options ?? {},
          });
        }
        continue;
      }
      const session = this.getOrCreateSession(threadId);
      if (session.runner.getStatus().kind !== 'idle' || session.runner.queue.size > 0) {
        continue;
      }
      // A routine wake leaves a turn another harness holds for a later pass. One
      // asked for by name goes ahead: taking the lease waits for the holder's to
      // run out, and if it does not, that is an error the caller hears about.
      const held = this.leaseOptions && (await heldElsewhere(this.leaseOptions, threadId));
      if (held && !scope?.threadId) {
        continue;
      }
      // Re-deliver the turn's own messages: the same ids resume it, and a resumed
      // turn reads its input from its checkpoint, not from these. They go back as
      // one arrival: handed over one at a time, the first would start a turn of
      // its own and that turn would not be this one.
      session.runner.queue.enqueueAll(
        turn.messageIds.map((id) => ({
          id,
          input: [],
          deliveryMode: 'next-turn',
          options: scope?.options ?? {},
          enqueuedAt: Date.now(),
        })),
      );
      woken.push(threadId);
    }
    return woken;
  }

  /**
   * The earliest time the harness has something to do, in epoch ms: a parked turn
   * that needs waking, or the next event of a scheduled source a trigger listens
   * to (`cron()`). Undefined when there is neither. A host with no process of its
   * own between events (a serverless worker) schedules its next `start()` and
   * `wake()` from this.
   * @public
   */
  async getNextWakeTime(): Promise<number | undefined> {
    let earliest = await this.#connections.triggers.nextDue();
    if (!this.sessionStore) {
      return earliest;
    }
    const now = this.now();
    for (const threadId of await this.sessionStore.threads()) {
      const due = await this.turnDueAt(threadId, now);
      if (due !== undefined) {
        earliest = earliest === undefined ? due : Math.min(earliest, due);
      }
    }
    return earliest;
  }

  /**
   * When a routine `wake()` would have something to do for the thread's turn: a
   * parked turn at its deadline, a turn cut off by a crash at once. Never before
   * another harness's lease on it runs out, since a wake before then does nothing.
   * Undefined for a turn that waits on something other than time, and one that is
   * stuck or stopped. A turn this harness is running is due one lease period from
   * now: the time to come back if the process running it is gone.
   */
  private async turnDueAt(threadId: string, now: number): Promise<number | undefined> {
    const turn = (await this.sessionStore?.load(threadId))?.turn;
    if (!turn || turn.stuck || (turn.stopped && !turn.parked)) {
      return undefined;
    }
    if (turn.parked && turn.parked.until === undefined) {
      return undefined;
    }
    // A turn with no park on record is cut off, unless it is simply running here.
    // (One that is parked may still be closing out in this process: it counts.)
    const runner = this.sessions.get(threadId)?.runner;
    if (!turn.parked && runner && runner.getStatus().kind !== 'idle') {
      // Running here. Should this process die, the turn is cut off, and it can be
      // picked up once the lease it held has run out: that is when to look again.
      // The turn ending, or parking, replaces this time with the real one.
      return this.leaseOptions ? now + this.leaseOptions.ttlMs + LEASE_WAIT_MARGIN_MS : undefined;
    }
    const due = turn.parked?.until ?? now;
    const heldUntil = this.leaseOptions
      ? await heldElsewhereUntil(this.leaseOptions, threadId)
      : undefined;
    return heldUntil === undefined ? due : Math.max(due, heldUntil);
  }

  /**
   * The tool calls a thread's turn holds for a person (spec 08 § Held tool calls):
   * calls waiting for approval, and calls whose tool left its result open. Each
   * carries what a decision needs to answer it.
   * @public
   */
  async pending(scope?: SessionScope | ExecutionScope): Promise<HeldCall[]> {
    const executionId = await this.heldExecutionId(scope);
    if (executionId === undefined) {
      return [];
    }
    const records = await heldCallsOf(this).list(executionId);
    return records.filter((record) => record.resolution === undefined).map(toHeldCall);
  }

  /**
   * Answer a held tool call: a decision for one that waits for approval, an output
   * for one that waits for its result. The turn then goes on — at once when it is
   * running here, and by being woken when it is parked.
   *
   * `scope` names the thread, or with `{ executionId }` an execution a host runs
   * itself through `harness.run()`.
   *
   * The first answer wins. The same answer again is a no-op, so a host may retry.
   * Pass the `argsHash` the call was shown with to make sure the answer is for it.
   *
   * @throws NoeticError `hold_refused` when the thread holds no such call,
   *   `argsHash` names different arguments, the answer is the wrong kind for the
   *   hold, or the call was already answered differently.
   * @internal Hosts answer through `execute()` with a `DecisionItem`, which
   *   carries an `executionId` for a call held by a run the host started itself.
   *   This is what that calls.
   */
  async resolveHeld(
    scope: SessionScope | ExecutionScope | undefined,
    answer: HeldResolution & {
      readonly callId: string;
      readonly argsHash?: string;
    },
    options?: ExecuteOptions,
  ): Promise<void> {
    const executionId = await this.heldExecutionId(scope);
    if (executionId === undefined) {
      throw new NoeticErrorImpl({
        kind: 'hold_refused',
        callId: answer.callId,
        reason: 'the thread has no turn holding a call',
      });
    }
    const { callId, argsHash, ...resolution } = answer;
    await heldCallsOf(this).resolve(executionId, {
      callId,
      argsHash,
      resolution,
    });
    // A turn running here was told; a parked one has to be resumed. An execution
    // the host runs itself is the host's to resume.
    if (scope && 'executionId' in scope) {
      return;
    }
    const threadId = scope?.threadId ?? DEFAULT_THREAD_ID;
    const runner = this.sessions.get(threadId)?.runner;
    if (runner?.context === undefined) {
      await this.wake({
        threadId,
        options,
      });
      return;
    }
    // The turn is running here and was told. But it may have been parking as the
    // answer landed, too late to hear it: once it has come to rest, look again.
    void runner
      .whenIdle()
      .then(async () => {
        if ((await this.sessionStore?.load(threadId))?.turn?.parked) {
          await this.wake({
            threadId,
            options,
          });
        }
      })
      .catch(() => undefined);
  }

  //#region Versions and the trail

  /**
   * The turns that stopped rather than redo a step that had a lasting effect under
   * another flow version (spec 23 § Versions). Each waits for a `DecisionItem`
   * with `continue`, `restart` or `abandon`, passed to `execute()` on its thread.
   * @public
   */
  async listStuckRuns(): Promise<StuckTurn[]> {
    if (!this.sessionStore) {
      return [];
    }
    const found: StuckTurn[] = [];
    for (const threadId of await this.sessionStore.threads()) {
      const turn = (await this.sessionStore.load(threadId))?.turn;
      if (!turn?.stuck) {
        continue;
      }
      found.push({
        threadId,
        executionId: turn.executionId,
        ...turn.stuck,
      });
    }
    return found;
  }

  /**
   * Settle a stuck turn (spec 23 § Versions). Resolves false when the thread has none.
   *
   * - `continue`: accept the difference. The turn resumes on this harness's
   *   version, and the step that no longer matches runs again.
   * - `restart`: forget what the turn recorded and run it from the top on this
   *   harness's version. Every step runs again, effects included.
   * - `abandon`: drop the turn. Its trail is kept.
   */
  private async settleStuckTurn(
    threadId: string,
    action: 'continue' | 'restart' | 'abandon',
    options?: ExecuteOptions,
  ): Promise<boolean> {
    const record = this.threadRecord(threadId);
    const turn = await record?.settle(action);
    if (!turn) {
      return false;
    }
    if (action === 'abandon') {
      await this.clearCheckpoint(turn.executionId);
      return true;
    }
    if (action === 'restart') {
      // The snapshot stays: it holds the turn's input. What the run recorded goes.
      // What the first run did still happened: its marks go on the trail first.
      const store = this.stepLedgerStore;
      if (store) {
        const { entries, seqs } = await store.load(turn.executionId);
        for (const [path, entry] of entries) {
          const seq = seqs.get(path);
          if (seq !== undefined) {
            await store.mark(turn.executionId, seq, stubOf(entry));
          }
        }
        await store.clear(turn.executionId);
      }
      await heldCallsOf(this).clear(turn.executionId);
      if (this.config.storage) {
        await clearPendingEntries(this.config.storage, turn.executionId);
      }
    }
    await this.wake({
      threadId,
      options,
    });
    return true;
  }

  /**
   * What a run did, step by step: who ran each step, under which flow version, and
   * the receipt of a step with a lasting effect (spec 23 § The trail). Marks outlive
   * the ledger entries they came from, so the trail of a finished run stays readable.
   *
   * `scope` names an execution, or a thread, whose recent turns are then listed in
   * order.
   * @public
   */
  async getAuditTrail(scope: SessionScope | ExecutionScope): Promise<TrailMark[]> {
    const store = this.stepLedgerStore;
    if (!store) {
      return [];
    }
    const executionIds =
      'executionId' in scope
        ? [
            scope.executionId,
          ]
        : ((await this.threadRecord(scope.threadId ?? DEFAULT_THREAD_ID)?.executions()) ?? []);
    const marks: TrailMark[] = [];
    for (const executionId of executionIds) {
      const kept = await store.trail(executionId);
      const live = [
        ...(await store.load(executionId)).entries.values(),
      ].map(stubOf);
      for (const mark of [
        ...kept,
        ...live,
      ]) {
        marks.push({
          executionId,
          ...mark,
        });
      }
    }
    return marks;
  }

  //#endregion

  //#region Triggers

  /**
   * Add a trigger while the harness runs (spec 35 § Triggers). A trigger written
   * with expressions only is kept in storage, so it is there again after a restart;
   * one with a function in it lasts for this process.
   *
   * @throws NoeticConfigError `CONNECTION_INVALID` for an id already in use, a
   *   missing event or an expression that does not parse; `CONNECTION_UNKNOWN` for
   *   an unknown connection.
   * @public
   */
  async addTrigger(trigger: ConnectionTrigger): Promise<void> {
    await this.start();
    await this.#connections.triggers.add(trigger);
    await this.announceWakeTimeQuietly();
  }

  /**
   * Stop and forget a trigger. Resolves false when there is none with that id.
   * @public
   */
  async removeTrigger(id: string): Promise<boolean> {
    // Started first, so a trigger kept from an earlier run is known to be there.
    await this.#connections.start();
    const removed = await this.#connections.triggers.remove(id);
    await this.announceWakeTimeQuietly();
    return removed;
  }

  /**
   * Every trigger the harness has: its own, and those added while it ran.
   * @public
   */
  listTriggers(): ConnectionTrigger[] {
    return this.#connections.triggers.list();
  }

  //#endregion

  /** The watchers that wake this harness's parked turns, when auto-wake is on. */
  private createParkWatchers(park: boolean | ParkConfig | undefined): ParkWatchers | undefined {
    if (this.parkGraceMs === undefined) {
      return undefined;
    }
    const config = park === true || park === undefined || park === false ? {} : park;
    if (config.autoWake === false) {
      return undefined;
    }
    const storage = this.config.storage;
    return new ParkWatchers(
      {
        listen: async (connection, request) => {
          await this.start();
          return this.#connections.registry.listenRaw(connection, request);
        },
        waits: async (executionId) => (storage ? resumableWaitsOf(storage, executionId) : []),
        tasks: async (executionId) => (storage ? pendingTasksOf(storage, executionId) : []),
        taskState: async (task, signal) => {
          try {
            await this.start();
            const status = await this.#connections.registry.taskStatus(
              task.connection,
              task.taskId,
              signal,
            );
            return status.state;
          } catch {
            return undefined;
          }
        },
        wake: async (threadId, options) =>
          (
            await this.wake({
              threadId,
              options,
            })
          ).length > 0,
        parked: async (threadId) => {
          const turn = (await this.sessionStore?.load(threadId))?.turn;
          return turn?.parked && !turn.stuck ? turn.executionId : undefined;
        },
        now: () => this.now(),
      },
      config.wakeDebounceMs ?? DEFAULT_WAKE_DEBOUNCE_MS,
      config.taskPollMs ?? DEFAULT_TASK_POLL_MS,
    );
  }

  /**
   * Messages that reached the runner while the thread's turn is parked or stuck
   * (one that landed as the turn was closing out, say). Starting a turn with them
   * would throw the waiting one away, so they are kept in storage for after it. A
   * steer wakes a parked turn, as one delivered a moment later would. An
   * `interrupt` is not set aside: replacing the turn is what it asks for.
   * Resolves true when the messages were set aside.
   */
  private async setAside(
    session: Session,
    record: ThreadRecord,
    messages: ReadonlyArray<QueuedMessage>,
  ): Promise<boolean> {
    const turn = await record.turn();
    if (!turn || (!turn.parked && !turn.stuck)) {
      return false;
    }
    if (messages.some((message) => message.deliveryMode === 'interrupt')) {
      return false;
    }
    if (messages.every((message) => turn.messageIds.includes(message.id))) {
      return false;
    }
    for (const message of messages) {
      if (!turn.messageIds.includes(message.id)) {
        await keepForLater(session, record, message);
      }
    }
    if (turn.parked && messages.some(isSteer)) {
      const { threadId } = session.runner;
      void session.runner.whenIdle().then(() =>
        this.wake({
          threadId,
          options: messages[0]?.options,
        }),
      );
    }
    return true;
  }

  /** Resume a parked turn when one of its held calls already has an answer. */
  private async wakeIfAnswered(threadId: string, executionId: string): Promise<void> {
    const records = await heldCallsOf(this).list(executionId);
    if (!records.some((record) => record.resolution !== undefined)) {
      return;
    }
    // The runner is still closing the parked turn out; let it go idle first.
    await this.sessions.get(threadId)?.runner.whenIdle();
    await this.wake({
      threadId,
    });
  }

  /**
   * A message delivered again after its turn finished (spec 23a § Sessions): a queue
   * that delivers at least once, or a webhook the sender retried. It is answered
   * with the answer that turn gave, and nothing runs. Resolves true when it was.
   */
  private async answerAgain(session: Session, message: QueuedMessage): Promise<boolean> {
    const record = session.record;
    if (!record || session.runner.getStatus().kind !== 'idle' || session.runner.queue.size > 0) {
      return false;
    }
    const text = await record.answerFor(message.id);
    if (text === undefined) {
      return false;
    }
    session.runner.answerWith(
      {
        items: await record.history(),
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
        text,
        replayed: true,
      },
      message.id,
    );
    return true;
  }

  /**
   * A message delivered again while this harness already has it in hand: its turn is
   * running, it is queued to run, or its turn finished a moment ago and the runner
   * has not gone idle yet (spec 23a § Sessions). Queuing it would run the same
   * message as a second turn once the first ends. It is dropped; the caller reads
   * the answer of the turn that has it. Resolves true when it was.
   */
  private async inHand(session: Session, message: QueuedMessage): Promise<boolean> {
    if (message.deliveryMode === 'interrupt') {
      return false;
    }
    const { runner, record } = session;
    if (runner.getStatus().kind === 'idle' && runner.queue.size === 0) {
      return false;
    }
    if (runner.queue.peekAll().some((queued) => queued.id === message.id)) {
      return true;
    }
    // Known from the first instant of the turn, before its record is written and
    // on a harness with no storage at all.
    if (runner.isRunning(message.id)) {
      return true;
    }
    if (!record) {
      return false;
    }
    if ((await record.turn())?.messageIds.includes(message.id)) {
      return true;
    }
    if ((await record.answerFor(message.id)) === undefined) {
      return false;
    }
    // Its turn finished earlier, and another is running now. It is not run again,
    // and it is not left unanswered: once the thread rests it is delivered again,
    // and answered from the record then (`turn_replayed` carries the answer).
    void runner
      .whenIdle()
      .then(() => this.deliver(session, message))
      .catch(() => undefined);
    return true;
  }

  /**
   * A message for a thread whose turn is parked (spec 23 § Parked turns). It must not
   * start a turn of its own: the thread has one in flight, and starting another would
   * abandon it. Resolves true when the message was taken care of here.
   *
   * - `next-turn` waits in storage for the parked turn to end.
   * - A steer wakes the turn, which offers it to the context layers as it would mid-round.
   * - `interrupt` is not handled here: it replaces the turn, as it does a running one.
   */
  private async deliverToParked(session: Session, message: QueuedMessage): Promise<boolean> {
    const record = session.record;
    if (!record || message.deliveryMode === 'interrupt') {
      return false;
    }
    if (session.runner.getStatus().kind !== 'idle' || session.runner.queue.size > 0) {
      return false;
    }
    const turn = await record.turn();
    if (!turn?.parked || turn.messageIds.includes(message.id)) {
      return false;
    }
    await keepForLater(session, record, message);
    if (isSteer(message)) {
      await this.wake({
        threadId: session.runner.threadId,
        options: message.options,
      });
    }
    return true;
  }

  /** The execution whose held calls `scope` names. */
  private heldExecutionId(
    scope: SessionScope | ExecutionScope | undefined,
  ): Promise<string | undefined> {
    if (scope && 'executionId' in scope) {
      return Promise.resolve(scope.executionId);
    }
    return this.turnExecutionId(scope?.threadId ?? DEFAULT_THREAD_ID);
  }

  /** The execution of the thread's turn in flight: running here, or stored. */
  private async turnExecutionId(threadId: string): Promise<string | undefined> {
    const running = this.sessions.get(threadId)?.runner.context;
    if (running) {
      return rootIdOf(running);
    }
    return (await this.sessionStore?.load(threadId))?.turn?.executionId;
  }

  /** The harness clock. */
  private now(): number {
    return this.config.now?.() ?? Date.now();
  }

  /** Hand the turn's lease back and return the thread record to best-effort writes. */
  private async releaseLease(session: Session): Promise<void> {
    const lease = session.lease;
    session.lease = undefined;
    session.record?.hold(undefined);
    await lease?.release();
  }

  /** The stored record for `threadId`, when durability is on. */
  private threadRecord(threadId: string): ThreadRecord | undefined {
    if (!this.sessionStore) {
      return undefined;
    }
    return new ThreadRecord(
      {
        store: this.sessionStore,
        version: this.version,
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
    return this.llm.callModel(request, {
      itemSchemas: this.itemSchemas,
      harness: this,
      traceExporter: this.traceExporter,
    });
  }

  //#endregion

  //#region decide

  async decide(request: DecideRequest): Promise<DecideResponse> {
    return this.llm.decide(request, (r) => this.callModel(r));
  }

  /**
   * The approval seam (spec 08 § Held tool calls): the `approveToolCall` approver
   * decides, and with none, or when it answers `hold`, the action is held until
   * a decision answers it. Resolves the settled decision.
   * @public
   */
  async approve(request: ApproveRequest): Promise<SteeringDecision> {
    const approval = await awaitApproval({
      harness: this,
      toolName: request.toolName,
      toolArgs: request.toolArgs,
      callId: request.callId,
      ctx: request.ctx,
      park: request.park,
      onHeld: (held) => {
        emitFrameworkEvent({
          broadcaster: getBroadcaster(request.ctx),
          agentName: this.config.name,
          eventType: 'tool_call_held',
          data: {
            ...held,
          },
        });
      },
    });
    return approval.decision;
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
   * input. Every link of an array is type-checked (`ValidStepChain`).
   *
   * @internal How one step runs another (`execCtx.harness.run` inside a step or a
   *   tool), and how a test runs a step on a context it built. A host's way in is
   *   `execute()`.
   */
  run<I, O>(step: Step<ContextData, I, O>, input: I, ctx: Context): Promise<O>;
  run<const T extends StepLike | ReadonlyArray<StepLike>>(
    steps: T & ValidStepChain<T>,
    input: StepsInput<T>,
    ctx: Context,
  ): Promise<StepsOutput<T>>;
  async run<I, O>(s: Steps<ContextData, I, O>, input: I, ctx: Context): Promise<O> {
    const root = toStep<ContextData, I, O>(s);
    // Called from inside a step that a bare `execute()` is running on this
    // root (a tool running a step on `toolCtx.ctx`): join that run. Treating
    // the context as a fresh root would initialize its layers mid-run and, on
    // return, close its channels and ACP sessions under the outer step.
    if (ctx.parent === null && !this.liveRoots.has(ctx.id) && isRootRunning(ctx)) {
      return execute(root, input, ctx);
    }
    let restore: (() => void) | undefined;
    await this.dropRerunsOnFailure(ctx, async () => {
      restore = await this.prepareRun(root, ctx);
    });
    try {
      return await this.executeClosingChannels(root, input, ctx);
    } finally {
      restore?.();
    }
  }

  /**
   * Everything `run()` does before the root executes: fail fast on a missing
   * model provider, connect, negotiate the root, wire the tool pool and run the
   * layers' `init` hooks. Returns what puts the tool pool back when the run
   * attached connections into a pool it found already built.
   */
  private async prepareRun<I, O>(
    root: Step<ContextData, I, O>,
    ctx: Context,
  ): Promise<(() => void) | undefined> {
    const missingModel = this.llm.missingModelFor(root);
    if (missingModel) {
      throw missingModel;
    }
    // Populate the unified tool pool when an embedder drives a step directly on
    // a bare `createContext()` context (the turn pipeline does this per turn).
    // Without it, steps that resolve tools dynamically from `ctx.unifiedTools`
    // — and any sub-agents spawned from them — would see no tools.
    await this.start();
    this.#connections.negotiateRoot(frameworkCast<Step>(root));
    if (!ctx.unifiedTools) {
      // A root run is its own turn: it attaches the entries its steps list.
      const connectionTools =
        ctx.parent === null
          ? await this.#connections.openTurn(ctx, undefined, frameworkCast<Step>(root))
          : this.#connections.tools(runRootOf(ctx).id);
      this.setUnifiedTools(ctx, [
        ...collectAllTools(root),
        ...this.harnessTools,
        ...connectionTools,
      ]);
    }
    const restore = ctx.unifiedTools
      ? await this.attachGraphTools(frameworkCast<Step>(root), ctx)
      : undefined;
    // Hydrate/recall/persist context on the bare `run()` path too (issue #48):
    // configuring `context` + `storage` must "just work" without going through
    // `execute()`/`seedSessionHistory`. Idempotent — see `ensureLayersInit`.
    await this.ensureLayersInit(ctx);
    return restore;
  }

  /**
   * Attaches the entries a graph built mid-turn lists (a JSON document a step
   * hydrates) and adds their tools to `ctx`'s pool for this run only, so the
   * rest of the turn keeps the tool set — and the prompt cache — it started
   * with. Returns what restores the pool.
   */
  private async attachGraphTools(root: Step, ctx: Context): Promise<(() => void) | undefined> {
    const tools = await this.#connections.attachGraph(runRootOf(ctx), root);
    if (!tools) {
      return undefined;
    }
    const pool = frameworkCast<{
      unifiedTools?: ReadonlyArray<Tool>;
    }>(ctx);
    const before = pool.unifiedTools;
    pool.unifiedTools = deduplicateTools([
      ...(before ?? []),
      ...tools,
    ]);
    return () => {
      pool.unifiedTools = before;
    };
  }

  /**
   * Runs `prepare`, ending any rerun allowance `ctx` carries from its restore
   * when it throws: a run that fails before executing still ends the restore's
   * allowance, as one that executes does.
   */
  private async dropRerunsOnFailure(ctx: Context, prepare: () => Promise<void>): Promise<void> {
    try {
      await prepare();
    } catch (error) {
      this.#connections.dropReruns(ctx);
      if (ctx.parent === null && !this.liveRoots.has(ctx.id)) {
        await this.#connections.release(ctx.id);
      }
      throw error;
    }
  }

  /** Run all layer `init` hooks before the first step executes. Per spec 11,
   *  init MUST complete before any recall fires so layer state is populated. */
  private async initAndRun<I, O>(s: Step<ContextData, I, O>, input: I, ctx: Context): Promise<O> {
    await this.dropRerunsOnFailure(ctx, () => this.ensureLayersInit(ctx));
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
      this.#connections.grantReruns(ctx);
      entry.ready = this.beginDurableRun(ctx).then(() => this.reconcileConnections(ctx));
    }
    try {
      await entry.ready;
      const result = await execute(s, input, ctx);
      return result;
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
          this.#connections.orphanRun(ctx.id);
        } else {
          await this.#connections.releaseRun(ctx.id);
          await this.endDurableRun(ctx);
        }
        // The turn's own connections end with it; a resume attaches them again.
        await this.#connections.release(ctx.id);
        await this.saveOutputOfRun(ctx.threadId);
        this.forgetOwnThread(ctx.threadId);
      }
    }
  }

  /**
   * Wait for what a run streamed to be saved. Display output never decides a run:
   * a save that failed is logged, stays queued for the next flush, and the run's
   * own result or error stands.
   */
  private async saveOutputOfRun(threadId: string): Promise<void> {
    try {
      await this.outputs.get(threadId)?.flush();
    } catch (error) {
      console.warn('[noetic] could not save the display output of a run:', error);
    }
  }

  /**
   * A thread named by a host-built context's own id has no later turns: once its
   * run ends, the harness drops its session and output store. What was saved stays
   * in storage under `output:<ctx.id>`.
   */
  private forgetOwnThread(threadId: string): void {
    // The thread is named by its context's id, so that context's root run is its only one.
    if (!this.ownThreads.delete(threadId) || this.liveRoots.has(threadId)) {
      return;
    }
    this.stopRecording.get(threadId)?.();
    this.stopRecording.delete(threadId);
    this.outputs.delete(threadId);
    this.sessions.delete(threadId);
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
    await this.#connections.reconcile(ctx, this.config.storage);
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

  /**
   * Launches a step — or an array of steps, run in sequence as one background
   * execution — in a fresh child context.
   */
  detachedSpawn<I, O>(
    step: Step<ContextData, I, O>,
    input: I,
    parentCtx: Context,
    overrides?: DetachedSpawnOverrides,
  ): DetachedHandle<O>;
  detachedSpawn<const T extends StepLike | ReadonlyArray<StepLike>>(
    steps: T & ValidStepChain<T>,
    input: StepsInput<T>,
    parentCtx: Context,
    overrides?: DetachedSpawnOverrides,
  ): DetachedHandle<StepsOutput<T>>;
  detachedSpawn<I, O>(
    s: Steps<ContextData, I, O>,
    input: I,
    parentCtx: Context,
    overrides?: DetachedSpawnOverrides,
  ): DetachedHandle<O> {
    /* NOT a checkpoint boundary, despite spec 23 listing one here: a DetachedHandle's
     * settle is only observable via `await()`, and calling it internally would consume
     * the result the caller is holding. The handle manifest is the adapter's own
     * durability surface (`listLive`/`reattach`), so nothing is lost. */
    return dispatchStepThroughAdapter(
      this,
      toStep<ContextData, I, O>(s),
      input,
      parentCtx,
      overrides,
    );
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
    /** View layers for the connections the turn attaches, after the harness's own. */
    _connectionViews?: ContextLayer[];
    _broadcaster?: EventBroadcaster;
  }): Context {
    const resolved = opts ?? {};
    // `ContextImpl` takes the layers as `layers`, so the option spelling is
    // dropped from `rest` rather than spread through under the wrong name.
    const { contextLayers, extraContextLayers, cwdInit, _connectionViews, ...rest } = resolved;
    const configuredLayers = contextLayers ?? this._contextLayers;
    const views = [
      ...this.#connections.views,
      ...(_connectionViews ?? []),
    ];
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
    const ledger = this.stepLedgerStore
      ? new StepLedger({
          executionId,
          store: this.stepLedgerStore,
          retention: this.stepLedgerRetention,
        })
      : undefined;
    ledger?.runAs(this.version);
    return new ContextImpl({
      ...rest,
      id: executionId,
      ...this.interactiveThread(resolved, executionId),
      harness: this,
      channelStore: this.channelStore,
      layers: effectiveLayers,
      itemSchemas,
      cwdState: resolveContextCwdState(this.rootCwdState, opts?.parent, cwdInit),
      // Without this `ctx.checkpoint()` is inert, and the boundaries below never
      // persist anything (a no-op when no CheckpointStore is configured).
      checkpointFn: (c) => this.checkpoint(c),
      ledger,
    });
  }

  /**
   * On an interactive harness, a root context a host builds joins its thread: it
   * gets the thread's broadcaster, so `run()` on it streams, and is recorded, like
   * a session turn. A context with no `threadId` is its own thread, named by its id.
   */
  private interactiveThread(
    opts: {
      parent?: Context;
      threadId?: string;
      _broadcaster?: EventBroadcaster;
    },
    executionId: string,
  ): {
    threadId?: string;
    _broadcaster?: EventBroadcaster;
  } {
    if (!this.interactive || opts.parent || opts._broadcaster) {
      return {};
    }
    const threadId = opts.threadId ?? executionId;
    if (opts.threadId === undefined) {
      this.ownThreads.add(threadId);
    }
    return {
      threadId,
      _broadcaster: this.getOrCreateSession(threadId).runner.broadcaster,
    };
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
    const next = (prior ?? Promise.resolve(true)).then(() => {
      // A harness that was replaced must not overwrite the new holder's snapshot.
      if (ctx instanceof ContextImpl && ctx.ledger?.isHeld === false) {
        return false;
      }
      return captureCheckpoint(this, ctx);
    });
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
    const restored = await restoreFromCheckpoint(this, executionId, restoreOptions);
    if (!restored) {
      return null;
    }
    if (restored.fromSnapshot) {
      this.restoredExecutions.add(executionId);
    }
    // The restored ledger is a new one: it records under this harness's version too.
    if (restored.ctx instanceof ContextImpl) {
      restored.ctx.ledger?.runAs(this.version);
    }
    await this.spend?.adopt(restored.ctx);
    // Granted only to the context this restore returns: a restore that fails, or a
    // later plain restore of the same id, never inherits it (spec 35 § Durability).
    if (rerun && rerun.length > 0) {
      this.#connections.holdReruns(restored.ctx, rerun);
    }
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
    await clearCheckpoint(this, executionId);
    // Calls the execution held for a person have nobody left to answer to.
    await heldCallsOf(this).clear(executionId);
    // Nor is anything left to pick up what its steps were waiting on.
    if (this.config.storage) {
      await clearPendingEntries(this.config.storage, executionId);
    }
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
      client: (): SpendClient | undefined => this.llm?.sdkClient,
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

  /** Records a channel warning on every live root's span (see `recordChannelWarning`). */
  private recordChannelWarning(warning: ChannelWarning): void {
    recordChannelWarning(warning, this.traceExporter, this.liveRoots.values());
  }

  createSpan(name: string, parent: Span | null): Span {
    return createHarnessSpan(name, parent);
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
