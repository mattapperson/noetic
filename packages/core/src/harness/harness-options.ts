import type {
  ArtifactStore,
  ConnectionEntries,
  ConnectionTrigger,
  SecretResolver,
} from '@noetic-tools/types';
import type { Verifier } from '@noetic-tools/types/verify';
import { createInMemoryArtifactStore } from '../runtime/in-memory-artifact-store';
import {
  createInMemoryFsAdapter,
  createInMemoryShellAdapter,
  createInMemorySubprocessAdapter,
} from './deps/adapters';
import type { LayerStateStore } from './deps/context';
import type { CheckpointStore, StepLedgerRetention } from './deps/runtime';
import { createCheckpointStore } from './deps/runtime';
import type {
  AgentHooks,
  CallModelRequest,
  ContextCacheConfig,
  ContextData,
  ContextLayer,
  CustomItem,
  CustomItemsBrand,
  DecideRequest,
  DecideResponse,
  DeliveryMode,
  FsAdapter,
  ItemSchemaConfig,
  LLMResponse,
  LlmProviderConfig,
  ProjectionPolicy,
  ShellAdapter,
  Steps,
  StorageAdapter,
  SubprocessAdapter,
  Tool,
  ToolApprover,
  TraceExporter,
  ZodType,
} from './deps/types';

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
  /**
   * The turn lease (spec 23 § One writer per turn). Used only when `adapter`
   * implements `swap`: each session turn then takes its thread's lease, so two
   * harnesses on one storage cannot both drive a turn, and a failed durable write
   * stops the turn instead of being logged.
   */
  lease?: TurnLeaseConfig;
  /**
   * Park a turn when every step in flight is a wait that can be resumed without
   * loss (spec 23 § Parked turns). The turn's lease is handed back, its response
   * resolves with `parked`, and `harness.wake()` resumes it. Needs a lease, so it
   * has no effect on storage without `swap`. Default `false`: a waiting turn holds
   * its process. `true` uses `DEFAULT_PARK_GRACE_MS`.
   */
  park?: boolean | ParkConfig;
}

/** @public Settings for parking. */
export interface ParkConfig {
  /**
   * How long every step in flight must stay waiting before the turn parks, in ms.
   * Keeps a turn whose event is about to arrive from parking and waking at once.
   * Default `DEFAULT_PARK_GRACE_MS` (100).
   */
  graceMs?: number;
  /**
   * Whether this harness wakes the turns it parked: at their deadline, and when an
   * event they wait for arrives on a harness connection. Default `true`, which
   * suits a long-lived process. Set `false` where no process lives between
   * requests; the host then calls `harness.wake()` itself.
   */
  autoWake?: boolean;
  /**
   * How long auto-wake waits after an event before waking the turn, in ms, so a
   * burst of events wakes it once. Default `DEFAULT_WAKE_DEBOUNCE_MS` (250).
   */
  wakeDebounceMs?: number;
  /**
   * How often auto-wake reads the state of a long operation a parked turn's call
   * waits on, in ms. Default `DEFAULT_TASK_POLL_MS` (5000).
   */
  taskPollMs?: number;
}

/** @public Settings for the turn lease. Every field has a default. */
export interface TurnLeaseConfig {
  /** This harness's name in the lease record. Default: a random id per harness. */
  holder?: string;
  /**
   * How long a lease lasts between renewals, in ms. It is renewed every third of
   * this while a turn runs; a harness that goes quiet for longer can be replaced.
   * Default `DEFAULT_LEASE_TTL_MS` (30 s).
   */
  ttlMs?: number;
  /**
   * How long a turn waits for a lease another harness holds, in ms, before it fails
   * with `lease_lost`. A holder that died stops renewing, so waiting one `ttlMs`
   * is enough to take over from it. Default: `ttlMs`.
   */
  waitMs?: number;
  /** The clock leases are timed by. Default `Date.now`. */
  now?: () => number;
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

/** `AgentHarness` constructor options. */
export interface AgentHarnessOpts<
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
   * The version of the flow this harness runs: any string the host changes when the
   * flow changes, such as a release tag or a hash (spec 23 § Versions). Every step a
   * run records carries it, so the trail shows which version handled each step. A
   * turn resumed under another version keeps the steps that still match, and stops
   * as stuck rather than redo one that had a lasting effect. A flow hydrated
   * from a JSON workflow (`hydrateWorkflow`) defaults to a hash of its document, so
   * editing the document is a new version. Any other flow without one behaves as
   * before: a resumed turn discards whatever no longer matches.
   */
  version?: string;
  /**
   * The clock wait deadlines, turn leases and wake times are read from. Default
   * `Date.now`. A host that drives time itself (a test, a replay) passes its own.
   */
  now?: () => number;
  /**
   * Approves or refuses calls to tools that declare `needsApproval`, after the
   * `beforeToolCall` layers allow them. Without one, those calls run
   * unapproved and the harness warns once per tool name.
   */
  approveToolCall?: ToolApprover;
  /**
   * The live things the agent works with — browsers, devices, apps, chat workspaces,
   * sources — keyed by name, or as a list of named entries (`[mcp({ name, … })]`)
   * (spec 35). Providers connect in `start()` and live as long as the harness.
   */
  connections?: ConnectionEntries;
  /** Connection events that start or join a turn (spec 35 § Triggers). */
  triggers?: ReadonlyArray<ConnectionTrigger>;
  /** The verifier `step.verify` uses (spec 37). */
  verification?: Verifier;
  /** @internal Test-only escape hatch to inject a mock callModel implementation. */
  _testCallModel?: (request: CallModelRequest) => Promise<LLMResponse>;
  /** @internal Test-only escape hatch to inject a mock decide implementation. */
  _testDecide?: (request: DecideRequest) => Promise<DecideResponse>;
}

/** The platform surfaces a harness runs against, defaults filled in. */
export interface EnvironmentAdapters {
  fs: FsAdapter;
  shell: ShellAdapter;
  subprocess: SubprocessAdapter;
  artifacts: ArtifactStore;
}

//#endregion

//#region Resolution

/**
 * The filesystem, shell, subprocess, and artifact store an environment configures,
 * each defaulting to an in-memory implementation.
 */
export function resolveEnvironmentAdapters(
  environment: AgentEnvironmentConfig | undefined,
): EnvironmentAdapters {
  return {
    fs: environment?.fs ?? createInMemoryFsAdapter(),
    shell: environment?.shell ?? createInMemoryShellAdapter(),
    subprocess: environment?.subprocess ?? createInMemorySubprocessAdapter(),
    artifacts: environment?.artifacts ?? createInMemoryArtifactStore(),
  };
}

/**
 * The checkpoint store a harness runs with: the one given, else a store over the
 * configured storage adapter, so durable storage alone turns resume on. None when
 * the harness sets `durability: false`.
 */
export function resolveCheckpointStore(
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

//#endregion
