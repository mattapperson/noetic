import type {
  ArtifactStore,
  ConnectionsConfig,
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
