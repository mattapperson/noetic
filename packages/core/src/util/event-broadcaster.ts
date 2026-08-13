import type { StreamEvent } from '@noetic-tools/types';

//#region Types

interface Waiter {
  resolve: (result: IteratorResult<StreamEvent>) => void;
  reject: (err: unknown) => void;
}

interface EventBroadcasterOpts {
  maxBufferSize?: number;
}

//#endregion

const DEFAULT_MAX_BUFFER_SIZE = 1e4;

//#region EventBroadcaster

/**
 * Multi-consumer broadcast channel with replay support for streaming events.
 *
 * Each consumer gets an independent iterator that replays buffered events
 * from the start, then receives new events as they are emitted.
 *
 * The buffer is bounded to `maxBufferSize` events (default 10,000). When the
 * buffer exceeds this limit, oldest events are trimmed and iterator cursors
 * are adjusted. Once all consumers have departed, new events are discarded
 * to prevent unbounded memory growth. This bounded buffer serves as the
 * backpressure mechanism — no additional flow control is needed for typical
 * LLM response sizes.
 *
 * @internal
 */
export class EventBroadcaster {
  private readonly buffer: StreamEvent[] = [];
  private readonly maxBufferSize: number;
  private isDone = false;
  private err?: Error;
  private readonly iterators: Set<BroadcastIterator> = new Set();
  private hasHadConsumers = false;

  constructor(opts?: EventBroadcasterOpts) {
    this.maxBufferSize = opts?.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  }

  /** Push an event to all active iterators and the replay buffer. */
  emit(event: StreamEvent): void {
    if (this.isDone) {
      return;
    }

    // Skip buffering when all consumers have departed
    if (this.hasHadConsumers && this.iterators.size === 0) {
      return;
    }

    this.buffer.push(event);

    // Trim buffer if it exceeds max size
    if (this.buffer.length > this.maxBufferSize) {
      const trimCount = this.buffer.length - this.maxBufferSize;
      this.buffer.splice(0, trimCount);
      // Adjust all active iterator cursors
      for (const iter of this.iterators) {
        iter.adjustCursor(trimCount);
      }
    }

    for (const iter of this.iterators) {
      iter.notify();
    }
  }

  /** Signal that no more events will be emitted. */
  complete(): void {
    if (this.isDone) {
      return;
    }
    this.isDone = true;
    for (const iter of this.iterators) {
      iter.notify();
    }
  }

  /** Signal an error to all consumers. */
  error(err: Error): void {
    if (this.isDone) {
      return;
    }
    this.isDone = true;
    this.err = err;
    for (const iter of this.iterators) {
      iter.notify();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    this.hasHadConsumers = true;
    const iter = new BroadcastIterator(this);
    this.iterators.add(iter);
    return iter;
  }

  /** @internal Access the buffer for iterators. */
  getBuffer(): ReadonlyArray<StreamEvent> {
    return this.buffer;
  }

  /** @internal Check if the broadcaster is finished. */
  get finished(): boolean {
    return this.isDone;
  }

  /** @internal Get the error if any. */
  get streamError(): Error | undefined {
    return this.err;
  }

  /** @internal Remove an iterator from the set. */
  removeIterator(iter: BroadcastIterator): void {
    this.iterators.delete(iter);
  }

  /** @internal Current buffer length (for testing). */
  get bufferSize(): number {
    return this.buffer.length;
  }
}

//#endregion

//#region BroadcastIterator

class BroadcastIterator implements AsyncIterator<StreamEvent> {
  private cursor = 0;
  /**
   * Parked `next()` calls, FIFO. The AsyncIterator protocol allows pipelined
   * `next()` calls (calling again before the previous promise settles), so a
   * single waiter slot would orphan all but the latest call — the overwritten
   * promises would never settle. `notify()` drains in arrival order.
   */
  private readonly waiters: Waiter[] = [];
  private returned = false;
  private readonly broadcaster: EventBroadcaster;

  constructor(broadcaster: EventBroadcaster) {
    this.broadcaster = broadcaster;
  }

  /** Adjust cursor when buffer is trimmed. */
  adjustCursor(trimCount: number): void {
    this.cursor = Math.max(0, this.cursor - trimCount);
  }

  /** Called by the broadcaster when new data or completion is available. */
  notify(): void {
    while (this.waiters.length > 0) {
      let result: IteratorResult<StreamEvent> | null;
      try {
        result = this.tryRead();
      } catch (err: unknown) {
        // Reject so the error propagates through the async iterator. The
        // broadcaster stays finished-with-error, so the loop drains every
        // remaining waiter with the same rejection.
        this.waiters.shift()!.reject(err);
        continue;
      }
      if (!result) {
        return;
      }
      this.waiters.shift()!.resolve(result);
    }
  }

  async next(): Promise<IteratorResult<StreamEvent>> {
    if (this.returned) {
      return {
        done: true,
        value: undefined,
      };
    }
    // Only read ahead when no one is parked — a pipelined next() must queue
    // BEHIND earlier calls so events are handed out in FIFO order.
    if (this.waiters.length === 0) {
      const result = this.tryRead();
      if (result) {
        return result;
      }
    }

    return new Promise<IteratorResult<StreamEvent>>((resolve, reject) => {
      this.waiters.push({
        resolve,
        reject,
      });
    });
  }

  /** Settle every parked waiter with `{ done: true }` — used on early exit. */
  private settleWaiters(): void {
    const drained = this.waiters.splice(0, this.waiters.length);
    for (const waiter of drained) {
      waiter.resolve({
        done: true,
        value: undefined,
      });
    }
  }

  async throw(err: Error): Promise<IteratorResult<StreamEvent>> {
    this.returned = true;
    this.broadcaster.removeIterator(this);
    this.settleWaiters();
    throw err;
  }

  async return(): Promise<IteratorResult<StreamEvent>> {
    this.returned = true;
    this.broadcaster.removeIterator(this);
    this.settleWaiters();
    return {
      done: true,
      value: undefined,
    };
  }

  private tryRead(): IteratorResult<StreamEvent> | null {
    const buffer = this.broadcaster.getBuffer();

    if (this.cursor < buffer.length) {
      const event = buffer[this.cursor];
      this.cursor++;
      return {
        done: false,
        value: event,
      };
    }

    if (this.broadcaster.finished) {
      this.broadcaster.removeIterator(this);
      const err = this.broadcaster.streamError;
      if (err) {
        throw err;
      }
      return {
        done: true,
        value: undefined,
      };
    }

    return null;
  }
}

//#endregion
