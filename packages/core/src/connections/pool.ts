/**
 * Pools and leases (spec 35 § Pools and leases, § Fresh connections). A
 * pool's provider implements `provision`. A lease is held by one run or one
 * parallel path and is never shared with another. The holding harness renews
 * it every 15 s; one not renewed for 2 min is reclaimed, so a crashed process
 * frees its connections, and a process that resumes within that time keeps
 * the same lease (lease records live in the harness `StorageAdapter`).
 *
 * A pool that is full queues the request until a connection is free or
 * `waitMs` passes. Connections are fresh: a released one is released to its
 * provider, never handed to another holder. `warm` connections are
 * provisioned ahead with an empty setup and serve requests that pass none.
 */

import type {
  Connection,
  ConnectionLease,
  ConnectionManifest,
  ConnectionPoolConfig,
  ConnectionProvider,
  ConnectOptions,
  FreshScope,
  StorageAdapter,
} from '@noetic-tools/types';
import { LEASE_RECLAIM_MS, LEASE_RENEW_MS } from '@noetic-tools/types';
import { z } from 'zod';
import { invalidConnectionError, unavailableError } from './errors';
import { runEvery } from './settle';

//#region Types

/** A lease change, as reported in `connection_changed`. */
export type LeaseChange = 'acquired' | 'renewed' | 'released' | 'reclaimed';

/** What a pool needs from the registry. */
export interface PoolDeps {
  readonly name: string;
  readonly provider: ConnectionProvider;
  readonly config: ConnectionPoolConfig;
  readonly storage: StorageAdapter;
  readonly connectOptions: (signal: AbortSignal) => ConnectOptions;
  readonly onLease?: (lease: ConnectionLease, change: LeaseChange) => void;
  readonly now?: () => number;
  /** Test hooks; default `LEASE_RENEW_MS` and `LEASE_RECLAIM_MS`. */
  readonly renewMs?: number;
  readonly reclaimMs?: number;
}

/** A connection held under a lease. */
export interface HeldConnection {
  readonly lease: ConnectionLease;
  readonly connection: Connection;
}

/** One request for a fresh connection. */
export interface AcquireRequest {
  /** The holder: the run id for `'run'`, the parallel path key for `'path'`. */
  readonly scopeKey: string;
  readonly scope: FreshScope;
  readonly setup: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

//#endregion

//#region Constants

/** How long a request queues on a full pool when `waitMs` is unset. */
export const DEFAULT_POOL_WAIT_MS = 6e4;

const StoredLeaseSchema = z.object({
  id: z.string(),
  expiresAt: z.number(),
});

//#endregion

//#region Helpers

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    timer.unref();
  }
}

//#endregion

//#region ConnectionPool

/** One pool of fresh connections. */
export class ConnectionPool {
  private readonly held = new Map<string, HeldConnection>();
  /** Holders that stopped renewing (a failed run): reclaimed once their lease expires. */
  private readonly orphaned = new Set<string>();
  private readonly acquiring = new Map<string, Promise<HeldConnection>>();
  private readonly idle: Connection[] = [];
  private provisioning = 0;
  /** Connections handed to an acquisition but not yet recorded as held. */
  private unrecorded = 0;
  private readonly waiters = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  /** The manifest of the last connection provisioned with no setup, kept after it is released. */
  private baseManifest: ConnectionManifest | undefined;
  private readonly now: () => number;
  private readonly renewMs: number;
  private readonly reclaimMs: number;
  private readonly controller = new AbortController();

  constructor(private readonly deps: PoolDeps) {
    const max = deps.config.max;
    if (!Number.isInteger(max) || max < 1) {
      throw invalidConnectionError(
        `Pool '${deps.name}' has max ${String(max)}.`,
        'Set pool.max to a whole number of at least 1.',
      );
    }
    if (!deps.provider.provision) {
      throw invalidConnectionError(
        `Connection '${deps.name}' is a pool but its provider cannot provision connections.`,
        'Use a provider that implements provision(), or drop the pool setting.',
      );
    }
    this.now = deps.now ?? Date.now;
    this.renewMs = deps.renewMs ?? LEASE_RENEW_MS;
    this.reclaimMs = deps.reclaimMs ?? LEASE_RECLAIM_MS;
  }

  /** Starts lease renewal and provisions `warm` connections. */
  async start(): Promise<void> {
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.renewAll().then(() => this.sweep());
      }, this.renewMs);
      unrefTimer(this.timer);
    }
    const warm = Math.min(this.deps.config.warm ?? 0, this.deps.config.max);
    while (this.idle.length + this.provisioning < warm) {
      this.idle.push(await this.provision({}));
    }
  }

  /**
   * Leases a fresh connection to `request.scopeKey`, or returns the one it already holds.
   *
   * @throws NoeticErrorImpl `connection_unavailable` when the pool stays full past `waitMs`.
   */
  acquire(request: AcquireRequest): Promise<HeldConnection> {
    const existing = this.held.get(request.scopeKey);
    if (existing) {
      // A resume within the reclaim window takes its lease back and renews it again.
      this.orphaned.delete(request.scopeKey);
      return Promise.resolve(existing);
    }
    const inFlight = this.acquiring.get(request.scopeKey);
    if (inFlight) {
      return inFlight;
    }
    const acquiring = this.acquireNew(request).finally(() => {
      this.acquiring.delete(request.scopeKey);
    });
    this.acquiring.set(request.scopeKey, acquiring);
    return acquiring;
  }

  /** Returns the lease `scopeKey` holds, releasing its connection. */
  async release(scopeKey: string, change: LeaseChange = 'released'): Promise<void> {
    const held = this.held.get(scopeKey);
    if (!held) {
      return;
    }
    this.held.delete(scopeKey);
    this.orphaned.delete(scopeKey);
    await this.deps.storage.delete(this.leaseKey(scopeKey));
    this.deps.onLease?.(held.lease, change);
    this.wake();
    await held.connection.release().catch(() => undefined);
  }

  /**
   * Stops renewing the lease `scopeKey` holds without releasing it: a failed
   * run keeps its connection for a resume within the reclaim window, after
   * which `sweep` reclaims it (spec 35 § Pools and leases).
   */
  orphan(scopeKey: string): void {
    if (this.held.has(scopeKey)) {
      this.orphaned.add(scopeKey);
    }
  }

  /** Reclaims every lease whose holder stopped renewing it. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const [scopeKey, held] of [
      ...this.held,
    ]) {
      if (held.lease.expiresAt < now) {
        await this.release(scopeKey, 'reclaimed');
      }
    }
  }

  /** The lease `scopeKey` holds, if any. */
  heldBy(scopeKey: string): HeldConnection | undefined {
    return this.held.get(scopeKey);
  }

  /** Every scope holding a lease. */
  holders(): ReadonlyArray<string> {
    return [
      ...this.held.keys(),
    ];
  }

  /**
   * The manifest a connection provisioned with no setup offers: undefined until
   * the pool has provisioned one. A provider may answer a setup with a
   * different manifest, so only this one stands for the pool when a need that
   * passes no setup is negotiated (spec 35 § Negotiation).
   */
  manifest(): ConnectionManifest | undefined {
    return this.baseManifest;
  }

  status(): {
    max: number;
    leased: number;
    idle: number;
  } {
    return {
      max: this.deps.config.max,
      leased: this.held.size,
      idle: this.idle.length,
    };
  }

  /** Releases every connection and stops renewing. */
  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    try {
      await runEvery([
        ...[
          ...this.held.keys(),
        ].map((scopeKey) => () => this.release(scopeKey)),
        ...this.idle
          .splice(0)
          .map((connection) => () => connection.release().catch(() => undefined)),
      ]);
    } finally {
      this.wake();
    }
  }

  private async acquireNew(request: AcquireRequest): Promise<HeldConnection> {
    const connection = await this.connectionFor(request);
    let lease: ConnectionLease;
    try {
      lease = await this.leaseFor(request);
    } catch (e) {
      this.unrecorded -= 1;
      await connection.release().catch(() => undefined);
      this.wake();
      throw e;
    }
    const held: HeldConnection = {
      lease,
      connection,
    };
    this.unrecorded -= 1;
    this.held.set(request.scopeKey, held);
    this.deps.onLease?.(lease, 'acquired');
    return held;
  }

  private async connectionFor(request: AcquireRequest): Promise<Connection> {
    const wantsWarm = Object.keys(request.setup).length === 0;
    const deadline = this.now() + (this.deps.config.waitMs ?? DEFAULT_POOL_WAIT_MS);
    for (;;) {
      if (this.closed) {
        throw unavailableError(this.deps.name, 'the pool is closed');
      }
      if (wantsWarm && this.idle.length > 0) {
        const warm = this.idle.shift();
        if (warm) {
          this.unrecorded += 1;
          return warm;
        }
      }
      if (this.inUse() < this.deps.config.max) {
        const fresh = await this.provision(request.setup);
        this.unrecorded += 1;
        return fresh;
      }
      const spare = this.idle.shift();
      if (spare) {
        await spare.release().catch(() => undefined);
        continue;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        throw unavailableError(this.deps.name, 'the pool stayed full past waitMs');
      }
      await this.waitForSpace(remaining, request.signal);
    }
  }

  private inUse(): number {
    return this.held.size + this.unrecorded + this.idle.length + this.provisioning;
  }

  private async provision(setup: Readonly<Record<string, unknown>>): Promise<Connection> {
    const provision = this.deps.provider.provision;
    if (!provision) {
      throw unavailableError(this.deps.name, 'the provider cannot provision connections');
    }
    this.provisioning += 1;
    try {
      const connection = await provision.call(
        this.deps.provider,
        {
          ...setup,
        },
        this.deps.connectOptions(this.controller.signal),
      );
      if (Object.keys(setup).length === 0) {
        this.baseManifest = connection.manifest;
      }
      return connection;
    } catch (e) {
      this.wake();
      const reason = e instanceof Error ? e.message : String(e);
      throw unavailableError(this.deps.name, `provisioning failed: ${reason}`);
    } finally {
      this.provisioning -= 1;
    }
  }

  private waitForSpace(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        this.waiters.delete(done);
        resolve();
      };
      const onAbort = (): void => {
        clearTimeout(timeout);
        this.waiters.delete(done);
        reject(
          unavailableError(this.deps.name, 'the request was cancelled while the pool was full'),
        );
      };
      const timeout = setTimeout(done, ms);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, {
        once: true,
      });
      this.waiters.add(done);
    });
  }

  private wake(): void {
    for (const waiter of [
      ...this.waiters,
    ]) {
      waiter();
    }
  }

  private leaseKey(scopeKey: string): string {
    return `noetic/connections/leases/${this.deps.name}/${scopeKey}`;
  }

  private async leaseFor(request: AcquireRequest): Promise<ConnectionLease> {
    const now = this.now();
    const stored = StoredLeaseSchema.safeParse(
      await this.deps.storage.get(this.leaseKey(request.scopeKey)),
    );
    const id = stored.success && stored.data.expiresAt > now ? stored.data.id : crypto.randomUUID();
    const lease: ConnectionLease = {
      id,
      pool: this.deps.name,
      scope: request.scope,
      holder: request.scopeKey,
      expiresAt: now + this.reclaimMs,
    };
    await this.deps.storage.set(this.leaseKey(request.scopeKey), {
      id,
      expiresAt: lease.expiresAt,
    });
    return lease;
  }

  private async renewAll(): Promise<void> {
    const now = this.now();
    for (const [scopeKey, held] of [
      ...this.held,
    ]) {
      if (this.orphaned.has(scopeKey)) {
        continue;
      }
      const lease: ConnectionLease = {
        ...held.lease,
        expiresAt: now + this.reclaimMs,
      };
      this.held.set(scopeKey, {
        lease,
        connection: held.connection,
      });
      await this.deps.storage.set(this.leaseKey(scopeKey), {
        id: lease.id,
        expiresAt: lease.expiresAt,
      });
      this.deps.onLease?.(lease, 'renewed');
    }
  }
}

//#endregion
