/**
 * Durable outbound queue for IPC transports.
 *
 * A pure transport primitive: persists caller-supplied outbound frames
 * (as opaque strings) with monotonically-increasing sequence numbers,
 * surfaces an `append()` hook, a `frameRange(startSeq)` replay hook,
 * and an `ackUpTo(seq)` compaction hook. The queue has zero knowledge
 * of frame shape or meaning — it's a sequenced, persisted FIFO whose
 * identity is the `socketPath` the transport is serving.
 *
 * Storage layout, keyed off a harness-supplied `StorageAdapter`:
 *
 *   durableOutboundQueue:<socketId>:meta        — `{ lastAckedSeq, headSeq }`
 *   durableOutboundQueue:<socketId>:frame:<seq> — the frame string
 *
 * The `socketId` is a stable identifier derived from `socketPath` that
 * is safe to embed in storage keys (slashes + reserved chars are
 * escaped). Each socketPath gets its own queue namespace.
 *
 * Two invariants the queue maintains:
 *
 *   1. `headSeq` is the highest seq ever assigned (monotonic, never
 *      reused even if the whole queue is compacted). Appends start at
 *      `headSeq + 1`.
 *   2. `lastAckedSeq <= headSeq` and no frame at seq <= lastAckedSeq
 *      is persisted. `ackUpTo(seq)` advances `lastAckedSeq` and
 *      deletes every frame with seq in `(previousAck, seq]`.
 *
 * Load-time recovery walks the `:frame:` prefix and merges with the
 * cached `:meta` doc; a crash between append and meta-flush leaves a
 * frame without a meta entry, which is treated as a legitimate entry
 * whose seq becomes `Math.max(headSeq, scannedSeq)`.
 */

import type { StorageAdapter } from '@noetic-tools/core';

//#region Types

/** @public Options for `createDurableOutboundQueue`. */
export interface CreateDurableOutboundQueueOptions {
  /**
   * Backing storage for frame persistence. Keys are namespaced under
   * `durableOutboundQueue:<socketId>:…` so multiple queues can share
   * the same adapter without colliding.
   */
  storage: StorageAdapter;
  /**
   * Identifies the queue namespace. Callers typically pass a socket
   * path; any stable string works. Reserved characters are encoded
   * before inclusion in storage keys.
   */
  socketPath: string;
}

/** @public One persisted entry returned from `frameRange`. */
export interface DurableFrameEntry {
  readonly seq: number;
  readonly frame: string;
}

/** @public Contract for the durable outbound queue. */
export interface DurableOutboundQueue {
  /**
   * Assign the next seq to `frame`, persist it, and return the entry.
   * Idempotent under crash: if the meta flush fails after the frame
   * write, a recovery scan re-detects the frame and resumes. Callers
   * should treat `append` as may-persist-before-returning and must not
   * rely on "not persisted" as an error-recovery signal.
   */
  append(frame: string): Promise<DurableFrameEntry>;
  /**
   * Return every persisted frame with `seq >= startSeq`, ordered by
   * seq ascending. Used by the transport to replay missed frames on
   * a reconnect that carries a resume watermark.
   */
  frameRange(startSeq: number): Promise<ReadonlyArray<DurableFrameEntry>>;
  /**
   * Advance the ack watermark and delete persisted frames with
   * `seq <= throughSeq`. A `throughSeq` at or below the current
   * `lastAckedSeq` is a no-op. A `throughSeq` greater than `headSeq`
   * is clamped to `headSeq` so a buggy peer can't mark un-appended
   * frames as acknowledged.
   */
  ackUpTo(throughSeq: number): Promise<void>;
  /**
   * Remove every persisted frame and settle the ack watermark — used on a
   * clean shutdown. `headSeq` is NOT reset (invariant 1: a seq is never
   * reused), so a queue that appends again after `clear()` continues the
   * sequence rather than restarting at 1 under clients that still hold a
   * pre-clear delivery watermark.
   */
  clear(): Promise<void>;
  /** Number of frames currently un-acked (`headSeq - lastAckedSeq`). */
  queueSize(): Promise<number>;
  /** Monotonic head seq — every appended frame gets head+1, head+2, …. */
  getHeadSeq(): number;
  /** Highest seq the peer has acknowledged. Frames at/below this are gone. */
  getLastAckedSeq(): number;
}

//#endregion

//#region Helpers

const QUEUE_PREFIX = 'durableOutboundQueue:';
const META_SUFFIX = ':meta';
const FRAME_SUFFIX_PREFIX = ':frame:';

interface QueueMeta {
  headSeq: number;
  lastAckedSeq: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isQueueMeta(value: unknown): value is QueueMeta {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.headSeq === 'number' && typeof value.lastAckedSeq === 'number';
}

/**
 * Map a socket path to a key-safe identifier. Percent-encodes so slashes,
 * colons, and other special chars survive a filesystem-backed storage
 * adapter without colliding with the storage's own delimiter semantics.
 */
function encodeSocketId(socketPath: string): string {
  return encodeURIComponent(socketPath);
}

function metaKey(socketId: string): string {
  return `${QUEUE_PREFIX}${socketId}${META_SUFFIX}`;
}

function frameKey(socketId: string, seq: number): string {
  // Zero-pad seq so lexicographic order matches numeric order — keeps
  // `storage.list(prefix)` scans cheap on backends that iterate keys
  // in sorted order (e.g. the file-backed adapter).
  const padded = String(seq).padStart(16, '0');
  return `${QUEUE_PREFIX}${socketId}${FRAME_SUFFIX_PREFIX}${padded}`;
}

function parseSeqFromFrameKey(key: string, socketId: string): number | null {
  const prefix = `${QUEUE_PREFIX}${socketId}${FRAME_SUFFIX_PREFIX}`;
  if (!key.startsWith(prefix)) {
    return null;
  }
  const rest = key.slice(prefix.length);
  const seq = Number.parseInt(rest, 10);
  if (!Number.isFinite(seq)) {
    return null;
  }
  return seq;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

//#endregion

//#region Factory

/**
 * @public
 * Build a durable outbound queue rooted at `socketPath`. The queue
 * hydrates its meta doc + frame scan from `storage` on construction; a
 * caller that reuses the same `(storage, socketPath)` pair across
 * parent restarts picks up exactly where the previous instance left off.
 */
export async function createDurableOutboundQueue(
  options: CreateDurableOutboundQueueOptions,
): Promise<DurableOutboundQueue> {
  const { storage, socketPath } = options;
  const socketId = encodeSocketId(socketPath);
  const framePrefix = `${QUEUE_PREFIX}${socketId}${FRAME_SUFFIX_PREFIX}`;

  // Hydrate meta.
  const metaRaw = await storage.get<unknown>(metaKey(socketId));
  let headSeq = isQueueMeta(metaRaw) ? metaRaw.headSeq : 0;
  let lastAckedSeq = isQueueMeta(metaRaw) ? metaRaw.lastAckedSeq : 0;

  // Recover any frame that was persisted before a meta-flush crash.
  const existingKeys = await storage.list(framePrefix);
  for (const key of existingKeys) {
    const seq = parseSeqFromFrameKey(key, socketId);
    if (seq !== null && seq > headSeq) {
      headSeq = seq;
    }
  }

  async function flushMeta(): Promise<void> {
    const meta: QueueMeta = {
      headSeq,
      lastAckedSeq,
    };
    await storage.set(metaKey(socketId), meta);
  }

  async function append(frame: string): Promise<DurableFrameEntry> {
    headSeq += 1;
    const seq = headSeq;
    await storage.set(frameKey(socketId, seq), frame);
    await flushMeta();
    return {
      seq,
      frame,
    };
  }

  async function frameRange(startSeq: number): Promise<ReadonlyArray<DurableFrameEntry>> {
    const keys = await storage.list(framePrefix);
    const pairs: Array<{
      seq: number;
      key: string;
    }> = [];
    for (const key of keys) {
      const seq = parseSeqFromFrameKey(key, socketId);
      if (seq === null || seq < startSeq) {
        continue;
      }
      pairs.push({
        seq,
        key,
      });
    }
    pairs.sort((a, b) => a.seq - b.seq);
    const out: DurableFrameEntry[] = [];
    for (const pair of pairs) {
      const raw = await storage.get<unknown>(pair.key);
      if (isString(raw)) {
        out.push({
          seq: pair.seq,
          frame: raw,
        });
      }
    }
    return out;
  }

  async function ackUpTo(throughSeq: number): Promise<void> {
    if (throughSeq <= lastAckedSeq) {
      return;
    }
    const effective = Math.min(throughSeq, headSeq);
    const previous = lastAckedSeq;
    lastAckedSeq = effective;
    /* Frame keys are computable from their seq — delete `(previous,
     * effective]` directly instead of a storage.list() scan. Acks fire on
     * every client watermark push, and a per-ack scan over a namespace that
     * shares its backing directory with checkpoints and ledger shards made
     * each ack O(total keys). `storage.delete` on an already-gone key is a
     * no-op by contract, so gaps (from clear/compaction) cost nothing. */
    for (let seq = previous + 1; seq <= effective; seq++) {
      await storage.delete(frameKey(socketId, seq));
    }
    await flushMeta();
  }

  async function clear(): Promise<void> {
    const keys = await storage.list(framePrefix);
    for (const key of keys) {
      await storage.delete(key);
    }
    /* headSeq stays MONOTONIC through a clear — invariant 1 says a seq is
     * never reused. Resetting to 0 here meant a queue cleared and then
     * appended-to restarted at seq 1, and any client still holding a
     * pre-clear `highestDeliveredDurableSeq` watermark would silently drop
     * every new frame up to it (client dedupe is `seq <= highestDelivered`).
     * Frames are gone; the counter is not. `lastAckedSeq` advances to
     * headSeq (everything persisted is deleted ⇒ everything is settled),
     * and the meta doc records both so a restart doesn't resurrect 0. */
    lastAckedSeq = headSeq;
    await flushMeta();
  }

  async function queueSize(): Promise<number> {
    /* In-memory bounds are authoritative: appends only persist inside
     * `(lastAckedSeq, headSeq]` and acks delete below the watermark. */
    return headSeq - lastAckedSeq;
  }

  return {
    append,
    frameRange,
    ackUpTo,
    clear,
    queueSize,
    getHeadSeq: () => headSeq,
    getLastAckedSeq: () => lastAckedSeq,
  };
}

//#endregion
