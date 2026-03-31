import type { StreamEvent } from '../types/harness-result';

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
  private waiter?: Waiter;
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
    if (!this.waiter) {
      return;
    }
    const w = this.waiter;
    this.waiter = undefined;
    try {
      const result = this.tryRead();
      if (result) {
        w.resolve(result);
      }
    } catch (err: unknown) {
      // Reject the waiter's promise so the error propagates through the async iterator
      w.reject(err);
    }
  }

  async next(): Promise<IteratorResult<StreamEvent>> {
    if (this.returned) {
      return {
        done: true,
        value: undefined,
      };
    }
    const result = this.tryRead();
    if (result) {
      return result;
    }

    return new Promise<IteratorResult<StreamEvent>>((resolve, reject) => {
      this.waiter = {
        resolve,
        reject,
      };
    });
  }

  async throw(err: Error): Promise<IteratorResult<StreamEvent>> {
    this.returned = true;
    this.broadcaster.removeIterator(this);
    throw err;
  }

  async return(): Promise<IteratorResult<StreamEvent>> {
    this.returned = true;
    this.broadcaster.removeIterator(this);
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
