import type { Channel, ChannelHandle, ExternalChannel } from '@noetic-tools/types';
import { frameworkCast, NoeticErrorImpl } from '@noetic-tools/types';

const MAX_TOPIC_TIMEOUT = 300_000; // 5 minutes
const DEFAULT_SEND_TIMEOUT = 30_000;
const RESOLVED: Promise<void> = Promise.resolve();

/** Build the `cancelled` error a blocked channel operation rejects with on abort. */
function cancelledError(signal: AbortSignal): NoeticErrorImpl {
  return new NoeticErrorImpl({
    kind: 'cancelled',
    reason: typeof signal.reason === 'string' ? signal.reason : undefined,
  });
}

/** Options accepted by internal (back-pressured) `send`. */
export interface ChannelSendOpts {
  /**
   * How long a sender may stay parked on a full queue before rejecting with
   * `channel_timeout`. Default 30s; `0` disables the timeout.
   */
  timeout?: number;
  /** Abort signal — rejects a parked sender with `cancelled`. */
  signal?: AbortSignal;
}

interface PendingSender<T> {
  value: T;
  /** Settles the parked send successfully (also releases timer/abort listener). */
  resolve: () => void;
  /** Settles the parked send with an error (also releases timer/abort listener). */
  reject: (e: Error) => void;
}

interface ChannelState<T> {
  mode: 'value' | 'queue' | 'topic';
  // value mode
  currentValue?: T;
  hasValue: boolean;
  valueWaiters: Array<{
    resolve: (v: T) => void;
    reject: (e: Error) => void;
  }>;
  // queue mode
  queue: T[];
  capacity: number;
  queueWaiters: Array<{
    resolve: (v: T) => void;
    reject: (e: Error) => void;
  }>;
  /**
   * Internal senders parked because the queue was at capacity (back-pressure),
   * FIFO. A dequeue (`recv`/`tryRecv`) promotes the oldest parked sender's
   * value into the freed slot and resolves its promise.
   */
  pendingSenders: Array<PendingSender<T>>;
  // topic mode
  topicSubscribers: Set<(value: T) => void>;
  /**
   * Non-consuming wake subscribers — fired by every `send()` regardless of mode,
   * after the primary delivery path runs. Used by `every({ wakeOn })` so the body
   * still sees pending queue / value entries on the next iteration.
   */
  wakeSubscribers: Set<() => void>;
  /**
   * External readers (`getChannelStream`) on topic/value channels. Unlike
   * `topicSubscribers` these are persistent and buffered — external consumers
   * must not lose values between `next()` calls. Queue-mode readers compete
   * through `queueWaiters` instead and never appear here.
   */
  externalSubscribers: Set<ExternalSubscriber<T>>;
}

export class ChannelStore {
  private channels = new Map<string, ChannelState<unknown>>();
  private closedExecutions = new Set<string>();
  /**
   * Ids a `ChannelHandle` was issued for. Handles have no dispose lifecycle,
   * so these are the only ids whose closure must be durably recorded (for
   * `handle.closed` / `channel_closed`). Streams are closed directly through
   * `subscribersByExecution`, so stream-only ids never accumulate here — a
   * session harness closing one root id per turn stays bounded.
   */
  private handleObserved = new Set<string>();
  private subscribersByExecution = new Map<string, Set<ExternalSubscriber<unknown>>>();

  private getOrCreate<T>(channel: Channel<T>): ChannelState<T> {
    let state = frameworkCast<ChannelState<T> | undefined>(this.channels.get(channel.name));
    if (!state) {
      state = {
        mode: channel.mode,
        hasValue: false,
        valueWaiters: [],
        queue: [],
        capacity: channel.capacity ?? 1_000,
        queueWaiters: [],
        pendingSenders: [],
        topicSubscribers: new Set(),
        wakeSubscribers: new Set(),
        externalSubscribers: new Set(),
      };
      this.channels.set(channel.name, frameworkCast<ChannelState<unknown>>(state));
    }
    return state;
  }

  /**
   * Subscribe to wake notifications on a channel without consuming any value.
   * Fired once on the next `send()` for any mode, then auto-removed. Returns
   * an `unsubscribe` so the caller can detach if it cancels first.
   */
  subscribeWake<T>(channel: Channel<T>, callback: () => void): () => void {
    const state = this.getOrCreate(channel);
    // Capture the set the callback is added to. `send()` swaps in a fresh set
    // before firing, so once a wake fires the captured `subscribers` is the
    // *old* set — this unsubscribe is then a no-op, which is correct.
    const subscribers = state.wakeSubscribers;
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  }

  /**
   * Internal-sender write with back-pressure (spec 06). Delivery is
   * synchronous when possible; the returned promise only parks when a queue
   * channel is at capacity:
   *
   * - **value**: store last-write-wins value, drain ALL parked recv waiters,
   *   resolve immediately.
   * - **queue**: hand off to a parked recv waiter or push below capacity —
   *   resolve immediately. At capacity, park the sender FIFO until a consumer
   *   dequeues an item; reject `channel_timeout` after `opts.timeout`
   *   (default 30s) or `cancelled` when `opts.signal` aborts.
   * - **topic**: deliver to current subscribers, resolve immediately.
   *
   * External callers use `ChannelHandle.send` (sync, drop-oldest) instead.
   */
  send<T>(channel: Channel<T>, value: T, opts?: ChannelSendOpts): Promise<void> {
    const state = this.getOrCreate(channel);
    let result: Promise<void> = RESOLVED;

    switch (state.mode) {
      case 'value':
        state.currentValue = value;
        state.hasValue = true;
        // Value-mode reads are non-consuming (last-write-wins), so once
        // hasValue flips true EVERY parked waiter must be drained — waking
        // only one would strand the rest until channel_timeout while new
        // recv calls succeed instantly. Splice in place: timeout timers and
        // abort listeners close over the array identity.
        if (state.valueWaiters.length > 0) {
          const drained = state.valueWaiters.splice(0, state.valueWaiters.length);
          for (const waiter of drained) {
            waiter.resolve(value);
          }
        }
        for (const sub of state.externalSubscribers) {
          sub.push(value);
        }
        break;
      case 'queue':
        if (state.queueWaiters.length > 0) {
          state.queueWaiters.shift()!.resolve(value);
        } else if (state.queue.length < state.capacity) {
          state.queue.push(value);
        } else {
          // At capacity — park the sender (back-pressure).
          result = this.parkSender(state, channel.name, value, opts);
        }
        break;
      case 'topic':
        for (const sub of state.topicSubscribers) {
          sub(value);
        }
        for (const sub of state.externalSubscribers) {
          sub.push(value);
        }
        break;
    }

    this.fireWakes(state);
    return result;
  }

  /** Park an internal sender on a full queue until a slot frees (FIFO). */
  private parkSender<T>(
    state: ChannelState<T>,
    channelName: string,
    value: T,
    opts?: ChannelSendOpts,
  ): Promise<void> {
    const timeout = opts?.timeout ?? DEFAULT_SEND_TIMEOUT;
    const signal = opts?.signal;
    if (signal?.aborted) {
      return Promise.reject(cancelledError(signal));
    }

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let removeAbortListener: (() => void) | null = null;

      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer);
        }
        removeAbortListener?.();
      };
      const entry: PendingSender<T> = {
        value,
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (e: Error) => {
          cleanup();
          reject(e);
        },
      };
      state.pendingSenders.push(entry);

      const removeEntry = (): boolean => {
        const idx = state.pendingSenders.indexOf(entry);
        if (idx < 0) {
          return false;
        }
        state.pendingSenders.splice(idx, 1);
        return true;
      };

      if (timeout > 0) {
        timer = setTimeout(() => {
          if (removeEntry()) {
            entry.reject(
              new NoeticErrorImpl({
                kind: 'channel_timeout',
                channelName,
                timeout,
              }),
            );
          }
        }, timeout);
      }

      if (signal) {
        const onAbort = (): void => {
          if (removeEntry()) {
            entry.reject(cancelledError(signal));
          }
        };
        signal.addEventListener('abort', onAbort, {
          once: true,
        });
        removeAbortListener = () => {
          signal.removeEventListener('abort', onAbort);
        };
      }
    });
  }

  /**
   * A dequeue freed a queue slot — shift the oldest parked sender's value
   * into it (FIFO) and resolve that sender's promise.
   */
  private promotePendingSender<T>(state: ChannelState<T>): void {
    if (state.pendingSenders.length === 0) {
      return;
    }
    if (state.queue.length >= state.capacity) {
      return;
    }
    const sender = state.pendingSenders.shift()!;
    state.queue.push(sender.value);
    sender.resolve();
  }

  /** Fire-and-reset the one-shot wake subscribers for a channel state. */
  private fireWakes<T>(state: ChannelState<T>): void {
    if (state.wakeSubscribers.size === 0) {
      return;
    }
    // Swap in a fresh set before firing so a callback that re-subscribes
    // (typical for `every` re-arming on its next iteration) lands on the
    // new set and survives until the next send.
    const wakers = state.wakeSubscribers;
    state.wakeSubscribers = new Set();
    for (const wake of wakers) {
      wake();
    }
  }

  async recv<T>(channel: Channel<T>, timeout = 30_000, signal?: AbortSignal): Promise<T> {
    // An already-aborted context must reject promptly rather than park a
    // waiter that nothing will ever wake (spec 09, Cancellation item 2).
    if (signal?.aborted) {
      throw cancelledError(signal);
    }
    const state = this.getOrCreate(channel);

    switch (state.mode) {
      case 'value':
        if (state.hasValue) {
          return state.currentValue!;
        }
        return this.waitWithTimeout(state.valueWaiters, channel.name, timeout, signal);

      case 'queue': {
        const head = this.dequeueHead(state);
        if (head) {
          return head.value;
        }
        // capacity-0 edge: senders can be parked while the queue is empty —
        // hand the oldest parked value straight to this receiver.
        if (state.pendingSenders.length > 0) {
          const sender = state.pendingSenders.shift()!;
          sender.resolve();
          return sender.value;
        }
        return this.waitWithTimeout(state.queueWaiters, channel.name, timeout, signal);
      }

      case 'topic': {
        // Clamp timeout to prevent indefinite subscriber leaks
        let effectiveTimeout = timeout;
        if (effectiveTimeout <= 0) {
          console.warn(
            `[noetic] Channel '${channel.name}': topic recv with non-positive timeout, clamping to ${MAX_TOPIC_TIMEOUT}ms`,
          );
          effectiveTimeout = MAX_TOPIC_TIMEOUT;
        }

        return new Promise<T>((resolve, reject) => {
          let removeAbortListener: (() => void) | null = null;
          const timer = setTimeout(() => {
            state.topicSubscribers.delete(handler);
            removeAbortListener?.();
            reject(
              new NoeticErrorImpl({
                kind: 'channel_timeout',
                channelName: channel.name,
                timeout: effectiveTimeout,
              }),
            );
          }, effectiveTimeout);

          const handler = (value: T) => {
            clearTimeout(timer);
            state.topicSubscribers.delete(handler);
            removeAbortListener?.();
            resolve(value);
          };
          state.topicSubscribers.add(handler);

          if (signal) {
            const onAbort = (): void => {
              clearTimeout(timer);
              state.topicSubscribers.delete(handler);
              reject(cancelledError(signal));
            };
            signal.addEventListener('abort', onAbort, {
              once: true,
            });
            removeAbortListener = () => {
              signal.removeEventListener('abort', onAbort);
            };
          }
        });
      }
    }
  }

  tryRecv<T>(channel: Channel<T>): T | null {
    const state = this.getOrCreate(channel);

    switch (state.mode) {
      case 'value':
        return state.hasValue ? state.currentValue! : null;
      case 'queue': {
        // Explicit head check (not `?? null`): a stored `undefined` must come
        // back as `undefined`, distinguishable from the empty-queue sentinel.
        const head = this.dequeueHead(state);
        return head ? head.value : null;
      }
      case 'topic':
        return null;
    }
  }

  private waitWithTimeout<T>(
    waiters: Array<{
      resolve: (v: T) => void;
      reject: (e: Error) => void;
    }>,
    channelName: string,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let removeAbortListener: (() => void) | null = null;

      // Symmetric cleanup: whichever path settles the waiter (delivery,
      // timeout, abort) must release both the timer and the abort listener.
      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer);
        }
        removeAbortListener?.();
      };
      const wrappedResolve = (v: T) => {
        cleanup();
        resolve(v);
      };
      const wrappedReject = (e: Error) => {
        cleanup();
        reject(e);
      };
      const entry = {
        resolve: wrappedResolve,
        reject: wrappedReject,
      };
      waiters.push(entry);

      const removeEntry = (): boolean => {
        const idx = waiters.indexOf(entry);
        if (idx < 0) {
          return false;
        }
        waiters.splice(idx, 1);
        return true;
      };

      if (timeout > 0) {
        timer = setTimeout(() => {
          if (removeEntry()) {
            wrappedReject(
              new NoeticErrorImpl({
                kind: 'channel_timeout',
                channelName,
                timeout,
              }),
            );
          }
        }, timeout);
      }

      if (signal) {
        const onAbort = (): void => {
          if (removeEntry()) {
            wrappedReject(cancelledError(signal));
          }
        };
        signal.addEventListener('abort', onAbort, {
          once: true,
        });
        removeAbortListener = () => {
          signal.removeEventListener('abort', onAbort);
        };
      }
    });
  }

  /**
   * External-sender write: synchronous, never back-pressured (spec 06,
   * External Sender Back-Pressure). At capacity the OLDEST queued item is
   * dropped (with a warning) so external callers never block.
   */
  private sendExternal<T>(channel: ExternalChannel<T>, value: T): void {
    const state = this.getOrCreate(channel);
    const isFullQueue =
      state.mode === 'queue' &&
      state.queueWaiters.length === 0 &&
      state.queue.length >= state.capacity;
    if (isFullQueue) {
      console.warn(
        `[noetic] Channel '${channel.name}': queue at capacity (${state.capacity}), dropping oldest message (external sender).`,
      );
      state.queue.shift();
      state.queue.push(value);
      this.fireWakes(state);
      return;
    }
    // Below capacity (or non-queue mode) the internal path resolves
    // synchronously — nothing can park here.
    void this.send(channel, value);
  }

  /**
   * External-reader subscription (spec 06, External Subscriptions). Delivery
   * by mode: `topic` is a persistent non-lossy tap (per-subscriber bounded
   * buffer, no replay of pre-subscribe values), `queue` competes with internal
   * `recv` waiters FIFO (external consumption frees parked senders), `value`
   * yields the current value then conflated updates.
   *
   * Channel state is keyed by NAME — `executionId` bounds only the
   * subscription's lifetime (it ends when `closeExecution(executionId)`
   * runs; queued values present at close drain first), never which values
   * are delivered. An id that is never closed yields an unbounded stream
   * the caller ends with `iterator.return()`. External waiters never time
   * out — they end via close instead. The returned iterable owns a single
   * iterator (generator semantics): subscribe again for a second consumer.
   */
  subscribe<T>(channel: ExternalChannel<T>, executionId: string): AsyncIterable<T> {
    if (this.closedExecutions.has(executionId)) {
      return CLOSED_ITERABLE;
    }
    const state = this.getOrCreate(channel);
    const subscriber: ExternalSubscriber<T> = new ExternalSubscriber<T>({
      channelName: channel.name,
      conflate: state.mode === 'value',
      takeShared:
        state.mode === 'queue'
          ? () => {
              const head = this.dequeueHead(state);
              if (head) {
                return head;
              }
              // capacity-0 edge: hand a parked sender's value straight over.
              const sender = state.pendingSenders.shift();
              if (!sender) {
                return null;
              }
              sender.resolve();
              return {
                value: sender.value,
              };
            }
          : undefined,
      parkShared:
        state.mode === 'queue'
          ? (waiter) => {
              state.queueWaiters.push(waiter);
              return () => {
                const idx = state.queueWaiters.indexOf(waiter);
                if (idx >= 0) {
                  state.queueWaiters.splice(idx, 1);
                }
              };
            }
          : undefined,
      onFinish: () => {
        state.externalSubscribers.delete(subscriber);
        const byExecution = this.subscribersByExecution.get(executionId);
        if (byExecution) {
          byExecution.delete(erased);
          if (byExecution.size === 0) {
            this.subscribersByExecution.delete(executionId);
          }
        }
      },
    });
    const erased = frameworkCast<ExternalSubscriber<unknown>>(subscriber);
    if (state.mode !== 'queue') {
      state.externalSubscribers.add(subscriber);
    }
    if (state.mode === 'value' && state.hasValue) {
      subscriber.push(state.currentValue!);
    }
    let byExecution = this.subscribersByExecution.get(executionId);
    if (!byExecution) {
      byExecution = new Set();
      this.subscribersByExecution.set(executionId, byExecution);
    }
    byExecution.add(erased);
    return subscriber;
  }

  /** Shift the queue head and promote the oldest parked sender into the freed slot. */
  private dequeueHead<T>(state: ChannelState<T>): {
    value: T;
  } | null {
    if (state.queue.length === 0) {
      return null;
    }
    const head = state.queue.shift()!;
    this.promotePendingSender(state);
    return {
      value: head,
    };
  }

  getHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T> {
    this.handleObserved.add(executionId);
    const store = this;
    return {
      get closed() {
        return store.closedExecutions.has(executionId);
      },
      channel,
      send(value: T) {
        if (store.closedExecutions.has(executionId)) {
          throw new NoeticErrorImpl({
            kind: 'channel_closed',
            channelName: channel.name,
          });
        }
        store.sendExternal(channel, value);
      },
    };
  }

  closeExecution(executionId: string): void {
    // Closure is durably recorded only for ids with issued handles — see
    // `handleObserved`. Consequence: a handle taken AFTER an execution
    // completed reads `closed === false`, and a stream subscribed after a
    // stream-only execution completed waits instead of ending; take handles
    // and subscribe before running.
    if (this.handleObserved.has(executionId)) {
      this.closedExecutions.add(executionId);
    }
    const subscribers = this.subscribersByExecution.get(executionId);
    if (!subscribers) {
      return;
    }
    this.subscribersByExecution.delete(executionId);
    for (const subscriber of subscribers) {
      subscriber.close();
    }
  }

  /**
   * A root run is (re)starting on this execution id: clear any previous
   * closure so checkpoint-restored and sequentially re-run root contexts get
   * working channels again instead of a permanently poisoned id.
   */
  openExecution(executionId: string): void {
    this.closedExecutions.delete(executionId);
  }
}

const MAX_EXTERNAL_BUFFER = 1_000;

const CLOSED_ITERABLE: AsyncIterable<never> & AsyncIterator<never> = {
  [Symbol.asyncIterator]() {
    return this;
  },
  next(): Promise<IteratorResult<never>> {
    return Promise.resolve({
      value: undefined,
      done: true,
    });
  },
};

interface ExternalSubscriberOpts<T> {
  channelName: string;
  /** Value mode: keep only the newest undelivered value. */
  conflate: boolean;
  /** Queue mode: take an available item from the shared queue state. */
  takeShared?: () => {
    value: T;
  } | null;
  /** Queue mode: park a waiter in the shared FIFO; returns an un-park. */
  parkShared?: (waiter: { resolve: (v: T) => void; reject: (e: Error) => void }) => () => void;
  /** Unregister this subscriber from the store. */
  onFinish: () => void;
}

/**
 * The iterator behind `ChannelStore.subscribe`. Topic/value subscribers are
 * push-fed via `push()`; queue subscribers pull from the shared queue state so
 * they compete fairly with internal `recv` waiters. `close()` (execution
 * completed) lets already-buffered values drain before ending; `return()`
 * (consumer walked away) drops them.
 */
class ExternalSubscriber<T> implements AsyncIterableIterator<T> {
  private buffer: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private parked: Array<{
    unpark: () => void;
    settleDone: () => void;
  }> = [];
  private done = false;
  /** Consumer called return(): stop pulling from the shared queue. */
  private detached = false;

  constructor(private opts: ExternalSubscriberOpts<T>) {}

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }

  /** Deliver a value to this subscriber (topic/value modes). */
  push(value: T): void {
    if (this.done) {
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({
        value,
        done: false,
      });
      return;
    }
    if (this.opts.conflate) {
      this.buffer = [
        value,
      ];
      return;
    }
    if (this.buffer.length >= MAX_EXTERNAL_BUFFER) {
      console.warn(
        `[noetic] Channel '${this.opts.channelName}': external subscriber buffer at capacity (${MAX_EXTERNAL_BUFFER}), dropping oldest value.`,
      );
      this.buffer.shift();
    }
    this.buffer.push(value);
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length > 0) {
      return Promise.resolve({
        value: this.buffer.shift()!,
        done: false,
      });
    }
    // Live shared-queue reads stop at close — close() snapshots the queue
    // into this.buffer, so a closed iterator can never steal values sent to
    // a later execution on the same channel name.
    const taken = this.done ? null : this.opts.takeShared?.();
    if (taken) {
      return Promise.resolve({
        value: taken.value,
        done: false,
      });
    }
    if (this.done) {
      return Promise.resolve({
        value: undefined,
        done: true,
      });
    }
    if (this.opts.parkShared) {
      return this.parkInSharedQueue(this.opts.parkShared);
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  return(): Promise<IteratorResult<T>> {
    this.detached = true;
    this.buffer = [];
    this.close();
    return Promise.resolve({
      value: undefined,
      done: true,
    });
  }

  /** End the iterator: settle every pending `next()` and unregister. Buffered values still drain. */
  close(): void {
    if (this.done) {
      return;
    }
    // Snapshot the shared queue's current contents into the private buffer
    // ("buffered values drain first") — after this the iterator never touches
    // live channel state again. A detached iterator (return()) walked away
    // and drains nothing.
    if (!this.detached && this.opts.takeShared) {
      for (let taken = this.opts.takeShared(); taken; taken = this.opts.takeShared()) {
        this.buffer.push(taken.value);
      }
    }
    this.done = true;
    this.opts.onFinish();
    for (const entry of this.parked.splice(0)) {
      entry.unpark();
      entry.settleDone();
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter({
        value: undefined,
        done: true,
      });
    }
  }

  /**
   * Queue mode: wait in the channel's shared waiter FIFO. No timer attaches,
   * so external waiters never reject with `channel_timeout` — `close()` ends
   * them instead.
   */
  private parkInSharedQueue(
    parkShared: NonNullable<ExternalSubscriberOpts<T>['parkShared']>,
  ): Promise<IteratorResult<T>> {
    return new Promise((resolve) => {
      const entry = {
        unpark: () => {},
        settleDone: () =>
          resolve({
            value: undefined,
            done: true,
          }),
      };
      const removeParked = (): void => {
        const idx = this.parked.indexOf(entry);
        if (idx >= 0) {
          this.parked.splice(idx, 1);
        }
      };
      entry.unpark = parkShared({
        resolve: (value: T) => {
          removeParked();
          resolve({
            value,
            done: false,
          });
        },
        reject: () => {
          removeParked();
          entry.settleDone();
        },
      });
      this.parked.push(entry);
    });
  }
}
