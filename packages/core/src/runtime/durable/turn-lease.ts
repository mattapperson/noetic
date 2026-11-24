/**
 * The turn lease: what makes one harness the only writer of a thread's turn
 * (spec 23 § One writer per turn).
 *
 * A lease is one small record per thread, taken with `StorageAdapter.swap`, so
 * two harnesses that reach for the same turn cannot both win. It carries a
 * `term` that goes up by one on every take. The step ledger tags what it writes
 * with the term, which is how a harness that stalled and came back finds out it
 * was replaced: its write loses to a higher term and it stops.
 *
 * Time bounds the lease, not correctness. `heldUntil` only decides when another
 * harness may take over from a holder that went quiet; the term decides whose
 * writes count.
 */

import type { StorageAdapter } from '@noetic-tools/context';
import { NoeticErrorImpl } from '@noetic-tools/types';
import { z } from 'zod';

//#region Types

const LeaseRecordSchema = z.object({
  /** Goes up by one on every take. */
  term: z.number().int().nonnegative(),
  /** The harness that holds it. */
  holder: z.string(),
  /** Epoch ms after which another harness may take over. `0` once released. */
  heldUntil: z.number(),
});

/** @internal The stored lease of one thread. */
export type LeaseRecord = z.infer<typeof LeaseRecordSchema>;

/** @internal Storage that can compare-and-set. */
export type SwapStorage = StorageAdapter & Required<Pick<StorageAdapter, 'swap'>>;

/** @public How long a turn lease lasts between renewals when a harness does not say. */
export const DEFAULT_LEASE_TTL_MS = 3e4;

/** @internal What a lease needs from its harness. */
export interface TurnLeaseOptions {
  readonly storage: SwapStorage;
  /** This harness's name for itself in the lease record. */
  readonly holder: string;
  readonly ttlMs: number;
  /** How long `take` waits for a lease another harness holds to run out. */
  readonly waitMs: number;
  readonly now: () => number;
}

/**
 * @internal
 * What the step ledger needs from a lease: the term to tag entries with, and a
 * way to stop the turn when a write proves another harness took over.
 */
export interface LedgerFence {
  readonly term: number;
  /** Throws `lease_lost` once the lease is lost or has run past `heldUntil`. */
  assert(): void;
  /**
   * `assert`, after reading the lease back from storage. A holder whose clock runs
   * slow can believe it still holds a lease another harness has taken; the stored
   * term settles it. Costs one read, so it guards what must not be repeated.
   */
  verify(): Promise<void>;
  /** Marks the lease lost and returns the error to throw. */
  lose(reason: string): NoeticErrorImpl;
}

//#endregion

//#region Helpers

/** @internal True when `storage` can compare-and-set. */
export function canSwap(storage: StorageAdapter | undefined): storage is SwapStorage {
  return typeof storage?.swap === 'function';
}

/** How often `take` looks again at a lease it is waiting on. */
const LEASE_POLL_MS = 100;

/** Resolves after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(1, ms));
    signal?.addEventListener('abort', done, {
      once: true,
    });
  });
}

/** True when a harness other than `holder` holds the lease and its time has not run out. */
function isHeldBy(record: LeaseRecord | null, holder: string, now: number): boolean {
  return record !== null && record.holder !== holder && record.heldUntil > now;
}

function leaseKey(threadId: string): string {
  return `session:${threadId}:lease`;
}

/** What is stored for a thread's lease: the value as read, and the lease it parses to. */
interface StoredLease {
  /** Exactly what storage holds, or null when nothing is. A swap compares against this. */
  raw: unknown;
  /** Null when nothing is stored, or what is stored is not a lease: it is free to take. */
  record: LeaseRecord | null;
}

async function readLease(storage: SwapStorage, threadId: string): Promise<StoredLease> {
  const raw = await storage.get<unknown>(leaseKey(threadId));
  const parsed = raw === null ? undefined : LeaseRecordSchema.safeParse(raw);
  return {
    raw,
    record: parsed?.success ? parsed.data : null,
  };
}

//#endregion

/** @internal True when a harness other than `opts.holder` holds the thread's lease now. */
export async function heldElsewhere(opts: TurnLeaseOptions, threadId: string): Promise<boolean> {
  const { record } = await readLease(opts.storage, threadId);
  return record !== null && record.holder !== opts.holder && record.heldUntil > opts.now();
}

//#endregion

//#region TurnLease

/**
 * @internal
 * One held lease. `take` is the only way to get one; `renew` keeps it while the
 * turn runs and `release` hands it back when the turn ends.
 */
export class TurnLease implements LedgerFence {
  private lostReason: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private onLost: ((reason: string) => void) | undefined;
  /** The execution this lease serves, once the turn knows it. */
  private boundTo: string | undefined;
  /** The renewal in flight, if one is. */
  private renewing: Promise<void> | undefined;

  private constructor(
    private readonly opts: TurnLeaseOptions,
    private readonly threadId: string,
    private record: LeaseRecord,
  ) {}

  /**
   * Take the thread's lease. A lease another harness holds is waited on for up to
   * `waitMs`: a holder that died stops renewing, so its lease runs out and the turn
   * can be picked up without the host retrying.
   *
   * @throws NoeticError `lease_lost` when another harness still holds it after the
   *   wait, or when another harness won the swap.
   */
  static async take(
    opts: TurnLeaseOptions,
    threadId: string,
    signal?: AbortSignal,
  ): Promise<TurnLease> {
    let stored = await readLease(opts.storage, threadId);
    let now = opts.now();
    const giveUpAt = Date.now() + opts.waitMs;
    while (isHeldBy(stored.record, opts.holder, now)) {
      const left = giveUpAt - Date.now();
      if (left <= 0 || signal?.aborted) {
        throw new NoeticErrorImpl({
          kind: 'lease_lost',
          executionId: threadId,
          term: stored.record?.term ?? 0,
          reason: `thread "${threadId}" is held by "${stored.record?.holder ?? 'another harness'}"`,
        });
      }
      const untilFree = (stored.record?.heldUntil ?? now) - now;
      await sleep(Math.min(left, untilFree, LEASE_POLL_MS), signal);
      stored = await readLease(opts.storage, threadId);
      now = opts.now();
    }
    const next: LeaseRecord = {
      term: (stored.record?.term ?? 0) + 1,
      holder: opts.holder,
      heldUntil: now + opts.ttlMs,
    };
    const won = await opts.storage.swap(leaseKey(threadId), stored.raw, next);
    if (!won) {
      throw new NoeticErrorImpl({
        kind: 'lease_lost',
        executionId: threadId,
        term: next.term,
        reason: `another harness took thread "${threadId}" first`,
      });
    }
    return new TurnLease(opts, threadId, next);
  }

  get term(): number {
    return this.record.term;
  }

  /** Name the execution this lease serves, for the errors it raises. */
  bind(executionId: string): void {
    this.boundTo = executionId;
  }

  /** True once this harness is known not to hold the lease. */
  get lost(): boolean {
    return this.lostReason !== undefined;
  }

  assert(): void {
    if (this.lostReason === undefined && this.record.heldUntil <= this.opts.now()) {
      this.markLost('the lease ran out before it was renewed');
    }
    if (this.lostReason !== undefined) {
      throw this.error(this.lostReason);
    }
  }

  lose(reason: string): NoeticErrorImpl {
    this.markLost(reason);
    return this.error(reason);
  }

  /**
   * Renew on a timer for as long as the turn runs. `onLost` is called once, when a
   * renewal or a ledger write shows the lease is gone, so the turn can be aborted.
   */
  keep(onLost: (reason: string) => void): void {
    this.onLost = onLost;
    const every = Math.max(1, Math.floor(this.opts.ttlMs / 3));
    this.timer = setInterval(() => {
      void this.renew();
    }, every);
  }

  /**
   * Push `heldUntil` out. A failed swap means another harness took the lease. One
   * renewal runs at a time: a second, started while storage is slow, would compare
   * against a record the first is about to replace and wrongly conclude it lost.
   */
  renew(): Promise<void> {
    this.renewing ??= this.renewOnce().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  private async renewOnce(): Promise<void> {
    if (this.lostReason !== undefined) {
      return;
    }
    const next: LeaseRecord = {
      ...this.record,
      heldUntil: this.opts.now() + this.opts.ttlMs,
    };
    let won: boolean;
    try {
      won = await this.opts.storage.swap(leaseKey(this.threadId), this.record, next);
    } catch {
      // Storage is unreachable: keep going until `heldUntil`, when `assert` stops the turn.
      return;
    }
    if (!won) {
      this.markLost('another harness took the lease');
      return;
    }
    this.record = next;
  }

  async verify(): Promise<void> {
    this.assert();
    const { record } = await readLease(this.opts.storage, this.threadId);
    if (record?.term !== this.record.term || record.holder !== this.record.holder) {
      this.markLost('another harness took the lease');
    }
    this.assert();
  }

  /** Hand the lease back so the next turn need not wait for it to run out. */
  async release(): Promise<void> {
    this.stopTimer();
    // A renewal in flight would otherwise land after this and keep the lease held.
    await this.renewing;
    if (this.lostReason !== undefined) {
      return;
    }
    const released: LeaseRecord = {
      ...this.record,
      heldUntil: 0,
    };
    try {
      await this.opts.storage.swap(leaseKey(this.threadId), this.record, released);
    } catch {
      // The lease runs out on its own.
    }
    this.lostReason = 'released';
  }

  private markLost(reason: string): void {
    if (this.lostReason !== undefined) {
      return;
    }
    this.lostReason = reason;
    this.stopTimer();
    this.onLost?.(reason);
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private error(reason: string): NoeticErrorImpl {
    return new NoeticErrorImpl({
      kind: 'lease_lost',
      executionId: this.boundTo ?? this.threadId,
      term: this.record.term,
      reason,
    });
  }
}

//#endregion
