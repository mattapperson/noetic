/**
 * The connection registry (spec 35 § Connection registry). Steps, tools and
 * documents never hold a provider's `Connection`: they resolve connections by
 * name when they run, and the registry wraps each one with the gates, refs,
 * blobs, secrets, identity tracking, reconnection and pool leases. A step that
 * runs after a reconnect therefore uses the new connection, and nothing can
 * reach a server around the harness.
 *
 * Providers connect in `start()` (the harness's `start()`, called by the first
 * `execute()` or `run()`). A connection that drops is marked unavailable and
 * reconnected with backoff while every other connection keeps working. When a
 * connection's manifest changes it is renegotiated against what the harness
 * graph requires; one that no longer satisfies it becomes unavailable.
 */

import type {
  AnyProfile,
  ArtifactStore,
  Connection,
  ConnectionChangedEventData,
  ConnectionConfig,
  ConnectionEvent,
  ConnectionEventEventData,
  ConnectionEventInit,
  ConnectionFrameworkEvent,
  ConnectionIdentity,
  ConnectionLease,
  ConnectionManifest,
  ConnectionRequirement,
  ConnectionState,
  ConnectionStatus,
  ConnectionsConfig,
  ConnectionTaskEventData,
  ConnectionTaskStatus,
  Context,
  EventStream,
  SecretResolver,
  StorageAdapter,
  StreamChangedEventData,
} from '@noetic-tools/types';
import { isConnectionProvider, normalizeConnectionEntry } from '@noetic-tools/types';
import { withholdSensitiveBlobs } from './blobs';
import type { ResumeDecision } from './durability';
import { resumeDecision } from './durability';
import {
  invalidConnectionError,
  notAllowedConnectionError,
  resumeRefusedError,
  unavailableError,
  unknownConnectionError,
} from './errors';
import { bufferedEventStream } from './event-stream';
import type { GateContext, GateHooks } from './gates';
import { admitIncoming, gatedAwaitTask, gatedCall } from './gates';
import { CONNECTION_NAME_PATTERN } from './handle';
import { checkRequirement } from './negotiation';
import type { LeaseChange } from './pool';
import { ConnectionPool } from './pool';
import type { RefKindInfo, RefScope } from './refs';
import { kindInfoFrom, RefSealer, refKindsOf } from './refs';
import type {
  ConnectionRegistry,
  ConnectionScope,
  GatedCallOptions,
  ResolvedConnection,
  ResolveRequest,
} from './registry-types';
import { SecretScrubber } from './secrets';
import { runEvery } from './settle';

//#region Types

/** A framework event the registry emits (`<agent>:<type>` on `getFullStream()`). */
export interface ConnectionFrameworkEventRecord {
  readonly type: ConnectionFrameworkEvent;
  readonly data:
    | ConnectionChangedEventData
    | ConnectionEventEventData
    | ConnectionTaskEventData
    | StreamChangedEventData;
  /** The context it concerns, when there is one. */
  readonly ctx?: Context;
}

/** Options for `createConnectionRuntime`. */
export interface ConnectionRuntimeOptions {
  readonly connections?: ConnectionsConfig;
  readonly storage: StorageAdapter;
  readonly artifacts: ArtifactStore;
  readonly secrets?: SecretResolver;
  readonly hooks?: GateHooks;
  readonly onFrameworkEvent?: (event: ConnectionFrameworkEventRecord) => void;
  /** Profiles known up front (from the graph's handles); handles add theirs when they resolve. */
  readonly profiles?: ReadonlyArray<AnyProfile>;
  readonly now?: () => number;
  /** Delay before reconnect attempt `n` (from 0). Default: 1 s doubling to 30 s. */
  readonly reconnectDelayMs?: (attempt: number) => number;
}

/** A resolve request with the extras the registry understands (now part of `ResolveRequest`). */
export type RuntimeResolveRequest = ResolveRequest;

/** The registry the harness holds: the `ConnectionRegistry` contract plus lifecycle. */
/** How a graph uses a connection, as far as negotiation cares. */
export interface NeedOptions {
  /**
   * The handle passes a setup. A pool's provider may answer each setup with a
   * different manifest, so a pool checks such a need on the lease instead.
   */
  readonly setup?: boolean;
}

export interface ConnectionRuntime extends ConnectionRegistry {
  resolve(request: RuntimeResolveRequest): Promise<ResolvedConnection>;
  /** Connects every provider and starts every pool. Idempotent. */
  start(): Promise<void>;
  /**
   * Stops renewing every lease a failed run holds, so it is reclaimed after the
   * reclaim window unless a resume takes it back first.
   */
  orphanRun(rootId: string): void;
  /** Whether `harness.restore(executionId, { rerun })` named connection `name` for this run. */
  rerunAllowed(executionId: string, name: string): boolean;
  /** Releases every connection and lease. */
  close(): Promise<void>;
  /** The harness configuration of a connection. */
  config(name: string): ConnectionConfig | undefined;
  /** The live provider connection behind a non-pool name, when it is ready. */
  current(name: string): Connection | undefined;
  /** Bumped every time an operation with effects runs on the connection. */
  effectCount(name: string): number;
  /** Records what the harness graph requires of a connection; renegotiated on manifest changes. */
  require(name: string, requirement: ConnectionRequirement, options?: NeedOptions): void;
  /**
   * Checks a requirement against the connection's current manifest without
   * recording it: how a `run()` root that is not the harness's `agentGraph` is
   * negotiated before it executes. A pool is checked against the manifest its
   * connections offer. Returns false when there is no manifest to check yet (the
   * connection is down, or the pool has provisioned nothing), leaving the
   * requirement to fail when the connection is used.
   *
   * A need that passes a pool a setup has nothing to check before the lease, so
   * it returns true and the lease checks it.
   *
   * @throws `NoeticConfigError` `CONNECTION_UNSATISFIED` when the manifest falls short.
   */
  check(name: string, requirement: ConnectionRequirement, options?: NeedOptions): boolean;
  /** Registers a profile's ref kinds. */
  registerProfile(profile: AnyProfile): void;
  /** Lets `harness.restore(id, { rerun })` drive replaced connections again. */
  allowRerun(executionId: string, names: ReadonlyArray<string>): void;
  /**
   * Decides what a resumed run does about a connection recorded against `recorded`,
   * resetting it when that is the decision.
   *
   * @throws NoeticErrorImpl `connection_resume_refused` when it cannot safely be driven again.
   */
  checkResume(params: {
    readonly executionId: string;
    readonly name: string;
    readonly recorded: ConnectionIdentity;
    readonly signal: AbortSignal;
  }): Promise<ResumeDecision>;
  /** Unsealed, un-buffered events for a trigger; the caller seals them per thread. */
  listenRaw(
    name: string,
    request: {
      readonly event: string;
      readonly arguments?: Readonly<Record<string, unknown>>;
      readonly cursor?: string | null;
      readonly signal: AbortSignal;
    },
  ): Promise<EventStream>;
  /** Scrubs secrets from, seals refs in, and links blobs in a value for a thread. */
  admit(
    name: string,
    value: unknown,
    scope: {
      readonly threadId: string;
      readonly executionId: string;
    },
  ): Promise<unknown>;
  /** Emits a framework event (used by triggers and steps). */
  emit(event: ConnectionFrameworkEventRecord): void;
  /** `value` with every sensitive blob withheld, for anything the model will see. */
  withholdSensitive(value: unknown): Promise<unknown>;
}

interface Entry {
  readonly name: string;
  readonly config: ConnectionConfig;
  readonly pool?: ConnectionPool;
  connection?: Connection;
  state: ConnectionState;
  reason?: string;
  connecting?: Promise<void>;
  unsubscribe?: () => void;
  effects: number;
  attempts: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  readonly requirements: ConnectionRequirement[];
}

//#endregion

//#region Helpers

const EXPOSE_VALUES = new Set([
  'eager',
  'all',
  'none',
]);

function defaultReconnectDelay(attempt: number): number {
  return Math.min(3e4, 1e3 * 2 ** attempt);
}

function errorReason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function unrefTimeout(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    timer.unref();
  }
}

function validateEntry(name: string, config: ConnectionConfig): void {
  if (!CONNECTION_NAME_PATTERN.test(name)) {
    throw invalidConnectionError(
      `Connection name '${name}' is not valid.`,
      'Start with a letter and use only letters, digits, _ and -.',
    );
  }
  if (!isConnectionProvider(config.provider)) {
    throw invalidConnectionError(
      `Connection '${name}' has no provider.`,
      'Pass mcp(…), a source, or any ConnectionProvider (an object with connect()).',
    );
  }
  if (config.expose !== undefined && !EXPOSE_VALUES.has(config.expose)) {
    throw invalidConnectionError(
      `Connection '${name}' has expose '${String(config.expose)}'.`,
      "Use expose: 'eager', 'all' or 'none'.",
    );
  }
}

function hostOnlyViolation(
  profile: AnyProfile | undefined,
  setup: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const hostOnly = profile?.definition.setup?.hostOnly ?? [];
  return hostOnly.find((field) => setup !== undefined && field in setup);
}

function validateSetup(
  name: string,
  profile: AnyProfile | undefined,
  setup: Readonly<Record<string, unknown>> | undefined,
): void {
  const field = hostOnlyViolation(profile, setup);
  if (field !== undefined) {
    throw notAllowedConnectionError(
      `Setup field '${field}' of connection '${name}' is reserved to the host.`,
      "Set host-only setup fields (an app's command or path) in the pool's own configuration.",
    );
  }
  const schema = profile?.definition.setup?.schema;
  if (!schema || setup === undefined) {
    return;
  }
  const parsed = schema.safeParse(setup);
  if (!parsed.success) {
    throw invalidConnectionError(
      `Setup for connection '${name}' does not match the ${profile.name} profile: ${parsed.error.message}`,
      "Pass only the setup fields the profile's setup schema accepts.",
    );
  }
}

//#endregion

//#region Runtime

class Runtime implements ConnectionRuntime {
  private readonly entries = new Map<string, Entry>();
  private readonly sealer: RefSealer;
  private readonly scrubber = new SecretScrubber();
  private readonly refKinds = new Map<string, RefKindInfo>();
  /** Every profile handles name, by id, handed to providers when they connect. */
  private readonly profiles = new Map<string, AnyProfile>();
  private readonly reruns = new Map<string, Set<string>>();
  private readonly controller = new AbortController();
  private starting: Promise<void> | undefined;
  private readonly now: () => number;

  constructor(private readonly options: ConnectionRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.sealer = new RefSealer(options.storage, this.now);
    for (const profile of options.profiles ?? []) {
      this.registerProfile(profile);
    }
    for (const [name, raw] of Object.entries(options.connections ?? {})) {
      const config = normalizeConnectionEntry(raw);
      validateEntry(name, config);
      this.entries.set(name, {
        name,
        config,
        pool: config.pool ? this.createPool(name, config) : undefined,
        state: 'connecting',
        effects: 0,
        attempts: 0,
        requirements: [],
      });
    }
  }

  //#region Registry contract

  names(): ReadonlyArray<string> {
    return [
      ...this.entries.keys(),
    ];
  }

  async resolve(request: RuntimeResolveRequest): Promise<ResolvedConnection> {
    const target = request.from ?? request.name;
    const entry = this.entries.get(target);
    if (!entry) {
      throw unknownConnectionError(target, this.names());
    }
    if (request.profile) {
      this.registerProfile(request.profile);
    }
    if (entry.pool) {
      return this.resolvePooled(entry, request);
    }
    if (request.fresh) {
      throw invalidConnectionError(
        `Connection '${target}' is not a pool, so it cannot give a fresh connection.`,
        `Give '${target}' a \`pool\` in the harness connections, or drop \`fresh\` from the handle.`,
      );
    }
    await this.ensureConnected(entry);
    const connection = this.requireReady(entry);
    this.negotiate(entry.name, connection.manifest, request);
    return this.wrap(entry, request.scope, request.ctx);
  }

  async releaseScope(scopeKey: string): Promise<void> {
    for (const entry of this.entries.values()) {
      await entry.pool?.release(scopeKey);
    }
  }

  async releaseRun(rootId: string): Promise<void> {
    // A rerun allowance covers one restore of the run; it ends with the run.
    this.reruns.delete(rootId);
    for (const [pool, holder] of this.runHolders(rootId)) {
      await pool.release(holder);
    }
  }

  orphanRun(rootId: string): void {
    this.reruns.delete(rootId);
    for (const [pool, holder] of this.runHolders(rootId)) {
      pool.orphan(holder);
    }
  }

  /** Every (pool, holder) pair a run holds: its `fresh: 'run'` lease and each `fresh: 'path'` lease. */
  private runHolders(rootId: string): Array<
    [
      ConnectionPool,
      string,
    ]
  > {
    const pathPrefix = `${rootId}:path:`;
    const found: Array<
      [
        ConnectionPool,
        string,
      ]
    > = [];
    for (const entry of this.entries.values()) {
      const pool = entry.pool;
      if (!pool) {
        continue;
      }
      for (const holder of pool.holders()) {
        if (holder === rootId || holder.startsWith(pathPrefix)) {
          found.push([
            pool,
            holder,
          ]);
        }
      }
    }
    return found;
  }

  status(name?: string): ReadonlyArray<ConnectionStatus> {
    const entries = name
      ? [
          this.entries.get(name),
        ].filter((e): e is Entry => e !== undefined)
      : [
          ...this.entries.values(),
        ];
    return entries.map((entry) => this.statusOf(entry));
  }

  //#endregion

  //#region Lifecycle

  start(): Promise<void> {
    if (!this.starting) {
      this.starting = this.startAll();
    }
    return this.starting;
  }

  async close(): Promise<void> {
    this.controller.abort();
    // Every entry is closed even when one throws; the first failure is rethrown.
    await runEvery(
      [
        ...this.entries.values(),
      ].map((entry) => () => this.closeEntry(entry)),
    );
  }

  private async closeEntry(entry: Entry): Promise<void> {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
    }
    const connection = entry.connection;
    try {
      await runEvery([
        () => entry.unsubscribe?.(),
        () => entry.pool?.close(),
      ]);
    } finally {
      entry.connection = undefined;
      this.setState(entry, 'closed', 'the harness closed');
      await connection?.release().catch(() => undefined);
    }
  }

  config(name: string): ConnectionConfig | undefined {
    return this.entries.get(name)?.config;
  }

  current(name: string): Connection | undefined {
    const entry = this.entries.get(name);
    return entry?.state === 'ready' ? entry.connection : undefined;
  }

  effectCount(name: string): number {
    return this.entries.get(name)?.effects ?? 0;
  }

  require(name: string, requirement: ConnectionRequirement, options?: NeedOptions): void {
    const entry = this.entries.get(name);
    if (!entry) {
      throw unknownConnectionError(name, this.names());
    }
    if (entry.pool && options?.setup) {
      return;
    }
    entry.requirements.push(requirement);
  }

  check(name: string, requirement: ConnectionRequirement, options?: NeedOptions): boolean {
    const entry = this.entries.get(name);
    if (entry?.pool && options?.setup) {
      return true;
    }
    const manifest = entry ? this.manifestOf(entry) : undefined;
    if (!manifest) {
      return false;
    }
    checkRequirement(name, manifest, requirement);
    return true;
  }

  /** The manifest an entry offers now: its connection's, or for a pool its members'. */
  private manifestOf(entry: Entry): ConnectionManifest | undefined {
    if (entry.pool) {
      return entry.pool.manifest();
    }
    return entry.connection?.manifest;
  }

  registerProfile(profile: AnyProfile): void {
    this.profiles.set(profile.id, profile);
    for (const [kind, info] of refKindsOf(profile)) {
      this.refKinds.set(kind, info);
    }
  }

  rerunAllowed(executionId: string, name: string): boolean {
    return this.reruns.get(executionId)?.has(name) ?? false;
  }

  allowRerun(executionId: string, names: ReadonlyArray<string>): void {
    const set = this.reruns.get(executionId) ?? new Set<string>();
    for (const name of names) {
      set.add(name);
    }
    this.reruns.set(executionId, set);
  }

  async checkResume(params: {
    readonly executionId: string;
    readonly name: string;
    readonly recorded: ConnectionIdentity;
    readonly signal: AbortSignal;
  }): Promise<ResumeDecision> {
    const entry = this.entries.get(params.name);
    if (!entry) {
      throw unknownConnectionError(params.name, this.names());
    }
    const connection = entry.pool
      ? this.pooledFor(entry.pool, params.executionId, params.recorded)
      : await this.readyConnection(entry);
    const decision = resumeDecision({
      recorded: params.recorded,
      current: connection?.identity ?? {
        surface: params.recorded.surface,
        instance: '(lease no longer held)',
      },
      determinism: connection?.manifest.determinism,
      rerunAllowed: this.rerunAllowed(params.executionId, params.name),
      canReset: connection?.reset !== undefined,
    });
    if (decision === 'refuse') {
      throw resumeRefusedError(
        params.name,
        `connection '${params.name}' was replaced (instance ${params.recorded.instance} → ${connection?.identity.instance ?? 'a new lease'}) and is not safe to drive again; restore with { rerun: ['${params.name}'] } to run it live`,
      );
    }
    if (decision === 'reset') {
      await connection?.reset?.({
        signal: params.signal,
      });
    }
    return decision;
  }

  private async readyConnection(entry: Entry): Promise<Connection> {
    await this.ensureConnected(entry);
    return this.requireReady(entry);
  }

  /**
   * The connection a run still holds from `pool` with the recorded identity, or
   * — when its lease is gone — any connection of the pool, whose determinism
   * stands for the pool's (undefined when none is held: treated as unsafe).
   */
  private pooledFor(
    pool: ConnectionPool,
    executionId: string,
    recorded: ConnectionIdentity,
  ): Connection | undefined {
    const pathPrefix = `${executionId}:path:`;
    const held = pool
      .holders()
      .map((holder) => pool.heldBy(holder))
      .filter((h): h is NonNullable<typeof h> => h !== undefined);
    const own = held.find(
      (h) =>
        (h.lease.holder === executionId || h.lease.holder.startsWith(pathPrefix)) &&
        h.connection.identity.instance === recorded.instance,
    );
    return own?.connection ?? held[0]?.connection;
  }

  async listenRaw(
    name: string,
    request: {
      readonly event: string;
      readonly arguments?: Readonly<Record<string, unknown>>;
      readonly cursor?: string | null;
      readonly signal: AbortSignal;
    },
  ): Promise<EventStream> {
    const entry = this.entries.get(name);
    if (!entry) {
      throw unknownConnectionError(name, this.names());
    }
    await this.ensureConnected(entry);
    return this.requireReady(entry).listen(request);
  }

  async admit(
    name: string,
    value: unknown,
    scope: {
      readonly threadId: string;
      readonly executionId: string;
    },
  ): Promise<unknown> {
    const entry = this.entries.get(name);
    const connection = entry?.connection;
    if (!entry || !connection) {
      throw unavailableError(name, 'the connection is not connected');
    }
    return admitIncoming(
      {
        scrubber: this.scrubber,
        refs: this.sealer,
        refScope: this.refScope(name, connection, scope.threadId),
        artifacts: this.options.artifacts,
        executionId: scope.executionId,
        name,
      },
      value,
    );
  }

  emit(event: ConnectionFrameworkEventRecord): void {
    this.options.onFrameworkEvent?.(event);
  }

  withholdSensitive(value: unknown): Promise<unknown> {
    return withholdSensitiveBlobs(value, this.options.artifacts);
  }

  //#endregion

  //#region Connecting

  private async startAll(): Promise<void> {
    const work: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.pool) {
        work.push(
          entry.pool.start().then(
            () => this.setState(entry, 'ready'),
            (e: unknown) => this.setState(entry, 'unavailable', errorReason(e)),
          ),
        );
        continue;
      }
      work.push(this.ensureConnected(entry).catch(() => undefined));
    }
    await Promise.all(work);
    for (const entry of [
      ...this.entries.values(),
    ]) {
      if (entry.pool) {
        this.renegotiatePool(entry, entry.pool);
        continue;
      }
      if (entry.connection) {
        this.renegotiate(entry, entry.connection);
      }
    }
  }

  /**
   * Checks what the harness graph requires of a pool against the manifest its
   * connections offer, once it has provisioned one; a pool that falls short is
   * unavailable, as a single connection would be.
   */
  private renegotiatePool(entry: Entry, pool: ConnectionPool): void {
    const manifest = pool.manifest();
    if (!manifest || entry.state !== 'ready') {
      return;
    }
    for (const requirement of entry.requirements) {
      try {
        checkRequirement(entry.name, manifest, requirement);
      } catch (e) {
        this.setState(entry, 'unavailable', errorReason(e));
        return;
      }
    }
  }

  private ensureConnected(entry: Entry): Promise<void> {
    if (entry.connection || entry.pool || entry.state === 'closed') {
      return Promise.resolve();
    }
    if (!entry.connecting) {
      entry.connecting = this.connect(entry).finally(() => {
        entry.connecting = undefined;
      });
    }
    return entry.connecting;
  }

  private async connect(entry: Entry): Promise<void> {
    this.setState(entry, 'connecting');
    try {
      const connections = await entry.config.provider.connect({
        name: entry.name,
        signal: this.controller.signal,
        artifacts: this.options.artifacts,
        profiles: [
          ...this.profiles.values(),
        ],
      });
      const [first, ...extra] = connections;
      if (!first) {
        throw new Error('the provider returned no connections');
      }
      this.attach(entry, first);
      this.attachExtra(entry, extra);
    } catch (e) {
      this.setState(entry, 'unavailable', errorReason(e));
      this.scheduleReconnect(entry);
      throw unavailableError(entry.name, errorReason(e));
    }
  }

  /** A provider serving several instances: each further one is `<name>-<id>`. */
  private attachExtra(entry: Entry, extra: ReadonlyArray<Connection>): void {
    for (const connection of extra) {
      const name = `${entry.name}-${connection.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
      const existing = this.entries.get(name);
      const sibling: Entry = existing ?? {
        name,
        config: entry.config,
        state: 'connecting',
        effects: 0,
        attempts: 0,
        requirements: [],
      };
      this.entries.set(name, sibling);
      this.attach(sibling, connection);
    }
  }

  private attach(entry: Entry, connection: Connection): void {
    entry.unsubscribe?.();
    entry.connection = connection;
    entry.attempts = 0;
    entry.unsubscribe = connection.onChange((change) => {
      if (change === 'manifest') {
        this.renegotiate(entry, connection);
        return;
      }
      this.emitChanged(entry);
    });
    this.setState(entry, 'ready');
    void connection.closed.then(({ reason }) => {
      if (entry.connection !== connection || entry.state === 'closed') {
        return;
      }
      entry.unsubscribe?.();
      entry.unsubscribe = undefined;
      entry.connection = undefined;
      this.setState(entry, 'unavailable', reason);
      this.scheduleReconnect(entry);
    });
  }

  private scheduleReconnect(entry: Entry): void {
    if (this.controller.signal.aborted || entry.reconnectTimer) {
      return;
    }
    const delay = (this.options.reconnectDelayMs ?? defaultReconnectDelay)(entry.attempts);
    entry.attempts += 1;
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = undefined;
      void this.ensureConnected(entry).catch(() => undefined);
    }, delay);
    unrefTimeout(entry.reconnectTimer);
  }

  private renegotiate(entry: Entry, connection: Connection): void {
    const down = connection.unavailable;
    if (down !== undefined) {
      this.setState(entry, 'unavailable', down);
      return;
    }
    for (const requirement of entry.requirements) {
      try {
        checkRequirement(entry.name, connection.manifest, requirement);
      } catch (e) {
        this.setState(entry, 'unavailable', errorReason(e));
        return;
      }
    }
    if (entry.state !== 'ready') {
      this.setState(entry, 'ready');
      return;
    }
    this.emitChanged(entry);
  }

  private requireReady(entry: Entry): Connection {
    const connection = entry.connection;
    if (entry.state !== 'ready' || !connection) {
      throw unavailableError(entry.name, entry.reason ?? `the connection is ${entry.state}`);
    }
    return connection;
  }

  private negotiate(
    name: string,
    manifest: ConnectionManifest,
    request: RuntimeResolveRequest,
  ): void {
    const requirement = request.requirement;
    if (!requirement) {
      return;
    }
    const parents =
      request.profile && requirement.profile?.name === request.profile.name
        ? request.profile.parents
        : undefined;
    checkRequirement(name, manifest, {
      ...requirement,
      parents,
    });
  }

  //#endregion

  //#region Pools

  private createPool(name: string, config: ConnectionConfig): ConnectionPool {
    const pool = config.pool;
    if (!pool) {
      throw invalidConnectionError(`Connection '${name}' has no pool.`, 'Internal error.');
    }
    return new ConnectionPool({
      name,
      provider: config.provider,
      config: pool,
      storage: this.options.storage,
      now: this.options.now,
      connectOptions: (signal) => ({
        name,
        signal,
        artifacts: this.options.artifacts,
        profiles: [
          ...this.profiles.values(),
        ],
      }),
      onLease: (lease, change) => this.emitLease(name, lease, change),
    });
  }

  private async resolvePooled(
    entry: Entry,
    request: RuntimeResolveRequest,
  ): Promise<ResolvedConnection> {
    const pool = entry.pool;
    if (!pool) {
      throw unavailableError(entry.name, 'the pool is missing');
    }
    validateSetup(entry.name, request.profile, request.setup);
    const held = await pool.acquire({
      scopeKey: request.scope.scopeKey,
      scope: request.fresh ?? 'run',
      setup: request.setup ?? {},
      signal: request.scope.signal,
    });
    try {
      this.negotiate(entry.name, held.connection.manifest, request);
    } catch (e) {
      await pool.release(request.scope.scopeKey);
      throw e;
    }
    return this.wrap(entry, request.scope, request.ctx, held.lease);
  }

  //#endregion

  //#region Wrapping

  private refScope(
    name: string,
    connection: Connection,
    threadId: string,
    lease?: ConnectionLease,
  ): RefScope {
    return {
      connection: name,
      threadId,
      instance: connection.identity.instance,
      ...(lease
        ? {
            lease: lease.id,
          }
        : {}),
      kindInfo: kindInfoFrom(this.refKinds),
    };
  }

  private connectionFor(
    entry: Entry,
    scopeKey: string,
    lease: ConnectionLease | undefined,
  ): Connection {
    if (!lease) {
      return this.requireReady(entry);
    }
    const held = entry.pool?.heldBy(scopeKey);
    if (!held || held.lease.id !== lease.id) {
      throw unavailableError(entry.name, `lease ${lease.id} is no longer held`);
    }
    return held.connection;
  }

  private gateContext(
    entry: Entry,
    scope: ConnectionScope,
    connection: Connection,
    ctx?: Context,
    lease?: ConnectionLease,
  ): GateContext {
    return {
      name: entry.name,
      connection,
      policy: entry.config.policy,
      executionId: scope.executionId,
      refScope: this.refScope(entry.name, connection, scope.threadId, lease),
      refs: this.sealer,
      scrubber: this.scrubber,
      secrets: this.options.secrets,
      artifacts: this.options.artifacts,
      hooks: this.options.hooks ?? {},
      onTask: (op, status, stepId) => this.emitTask(entry.name, op, status, ctx, stepId),
      onEffect: () => {
        entry.effects += 1;
      },
    };
  }

  private wrap(
    entry: Entry,
    scope: ConnectionScope,
    ctx: Context | undefined,
    lease?: ConnectionLease,
  ): ResolvedConnection {
    const current = (): Connection => this.connectionFor(entry, scope.scopeKey, lease);

    const resolved: ResolvedConnection = {
      name: entry.name,
      lease,
      get manifest(): ConnectionManifest {
        return current().manifest;
      },
      identity: () => current().identity,
      call: async (
        op: string,
        args: unknown,
        opts: GatedCallOptions & {
          ctx?: Context;
        },
      ) =>
        gatedCall(this.gateContext(entry, scope, current(), opts.ctx ?? ctx, lease), {
          op,
          args,
          opts: {
            ...opts,
            ctx: opts.ctx ?? ctx,
          },
        }),
      awaitTask: async (taskId: string, op: string, opts: GatedCallOptions) =>
        gatedAwaitTask(this.gateContext(entry, scope, current(), opts.ctx ?? ctx, lease), {
          op,
          taskId,
          opts: {
            ...opts,
            ctx: opts.ctx ?? ctx,
          },
        }),
      read: async (resource, opts) => {
        const connection = current();
        const value = await connection.read(resource, opts);
        return admitIncoming(this.gateContext(entry, scope, connection, ctx, lease), value);
      },
      listen: (req) =>
        this.listenWrapped(entry, scope, current(), {
          ...req,
          ctx,
          lease,
        }),
      ...(current().reset
        ? {
            reset: (opts: { signal: AbortSignal }) => current().reset?.(opts) ?? Promise.resolve(),
          }
        : {}),
    };
    return resolved;
  }

  private listenWrapped(
    entry: Entry,
    scope: ConnectionScope,
    connection: Connection,
    req: {
      readonly event: string;
      readonly arguments?: Readonly<Record<string, unknown>>;
      readonly cursor?: string | null;
      readonly signal: AbortSignal;
      readonly ctx?: Context;
      readonly lease?: ConnectionLease;
    },
  ): EventStream<ConnectionEvent> {
    const gc = this.gateContext(entry, scope, connection, req.ctx, req.lease);
    const source = connection.listen({
      event: req.event,
      arguments: req.arguments,
      cursor: req.cursor,
      signal: req.signal,
    });
    return bufferedEventStream(source, {
      transform: async (event: ConnectionEventInit): Promise<ConnectionEvent> => {
        const payload = await admitIncoming(gc, event.payload);
        return {
          ...event,
          payload,
          connection: entry.name,
        };
      },
      onEvent: (event) =>
        this.emit({
          type: 'connection_event',
          data: {
            connection: entry.name,
            event,
          },
          ctx: req.ctx,
        }),
      onChange: (change) =>
        this.emit({
          type: 'stream_changed',
          data: {
            connection: entry.name,
            event: req.event,
            change: change.change,
            reason: change.reason,
          },
          ctx: req.ctx,
        }),
    });
  }

  //#endregion

  //#region Status and events

  private statusOf(entry: Entry): ConnectionStatus {
    return {
      name: entry.name,
      state: entry.state,
      ...(entry.connection
        ? {
            identity: entry.connection.identity,
          }
        : {}),
      ...(entry.reason && entry.state !== 'ready'
        ? {
            reason: entry.reason,
          }
        : {}),
      ...(entry.pool
        ? {
            pool: entry.pool.status(),
          }
        : {}),
    };
  }

  private setState(entry: Entry, state: ConnectionState, reason?: string): void {
    entry.state = state;
    entry.reason = reason;
    this.emitChanged(entry);
  }

  private emitChanged(entry: Entry): void {
    this.emit({
      type: 'connection_changed',
      data: {
        connection: entry.name,
        state: entry.state,
        ...(entry.connection
          ? {
              identity: entry.connection.identity,
            }
          : {}),
        ...(entry.reason
          ? {
              reason: entry.reason,
            }
          : {}),
      },
    });
  }

  private emitLease(name: string, lease: ConnectionLease, change: LeaseChange): void {
    const entry = this.entries.get(name);
    this.emit({
      type: 'connection_changed',
      data: {
        connection: name,
        state: entry?.state ?? 'ready',
        lease: {
          ...lease,
          change,
        },
      },
    });
  }

  private emitTask(
    name: string,
    op: string,
    status: ConnectionTaskStatus,
    ctx?: Context,
    stepId?: string,
  ): void {
    this.emit({
      type: 'connection_task',
      data: {
        connection: name,
        op,
        ...(stepId
          ? {
              stepId,
            }
          : {}),
        status,
      },
      ctx,
    });
  }

  //#endregion
}

//#endregion

//#region Public API

/**
 * Creates a harness connection registry. Construction validates the
 * configuration synchronously; providers connect in `start()`.
 *
 * @throws NoeticConfigError `CONNECTION_INVALID` for a malformed entry.
 */
export function createConnectionRuntime(options: ConnectionRuntimeOptions): ConnectionRuntime {
  return new Runtime(options);
}

//#endregion
