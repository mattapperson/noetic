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
}

export class ChannelStore {
  private channels = new Map<string, ChannelState<unknown>>();
  private closedExecutions = new Set<string>();

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
        if (state.queue.length > 0) {
          const head = state.queue.shift()!;
          this.promotePendingSender(state);
          return head;
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
        if (state.queue.length > 0) {
          const head = state.queue.shift()!;
          this.promotePendingSender(state);
          return head;
        }
        return null;
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

  getHandle<T>(channel: ExternalChannel<T>, executionId: string): ChannelHandle<T> {
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
    this.closedExecutions.add(executionId);
  }
}
