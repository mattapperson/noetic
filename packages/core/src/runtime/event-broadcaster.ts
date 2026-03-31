import type { StreamEvent } from '../types/harness-result';

//#region Types

interface Waiter {
  resolve: (result: IteratorResult<StreamEvent>) => void;
}

//#endregion

//#region EventBroadcaster

/**
 * Multi-consumer broadcast channel with replay support for streaming events.
 *
 * Each consumer gets an independent iterator that replays buffered events
 * from the start, then receives new events as they are emitted.
 *
 * @internal
 */
export class EventBroadcaster {
  private readonly buffer: StreamEvent[] = [];
  private isDone = false;
  private err?: Error;
  private readonly iterators: Set<BroadcastIterator> = new Set();

  /** Push an event to all active iterators and the replay buffer. */
  emit(event: StreamEvent): void {
    if (this.isDone) {
      return;
    }
    this.buffer.push(event);
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

  /** Called by the broadcaster when new data or completion is available. */
  notify(): void {
    if (!this.waiter) {
      return;
    }
    const w = this.waiter;
    this.waiter = undefined;
    const result = this.tryRead();
    if (result) {
      w.resolve(result);
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

    return new Promise<IteratorResult<StreamEvent>>((resolve) => {
      this.waiter = {
        resolve,
      };
    });
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
